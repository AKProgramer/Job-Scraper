const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const crypto = require("crypto");
const { persistRoleJobs, sleep } = require("./scraperShared");

// ---------------------------------------
// Role configuration (matches IndeedScraper)
// ---------------------------------------
const jobRoles = [
  "Computer Operator",
  "Clerk",
  "Data Entry",
  "Intern",
  "Construction Worker",
  "Construction Manager",
  "Construction Project Manager",
  "Construction Coordinator",
  "Site Supervisor",
  "Developer",
  "Social Media Manager",
  "Graphic Designer",
  "Content Writer",
  "Automation",
  "AI"
];

const configuredRoleFilter = process.env.JOB_SCRAPER_ROLES
  ? process.env.JOB_SCRAPER_ROLES.split(",")
      .map((role) => role.trim().toLowerCase())
      .filter(Boolean)
  : null;

const filteredJobRoles = configuredRoleFilter
  ? jobRoles.filter((role) => configuredRoleFilter.includes(role.toLowerCase()))
  : jobRoles;

const configuredLimit = parseInt(process.env.JOB_SCRAPER_LIMIT, 10);
const configuredJobResultLimit = parseInt(
  process.env.JOB_SCRAPER_RESULTS_PER_ROLE || "1",
  10
);
const rolesToScrape =
  Number.isFinite(configuredLimit) && configuredLimit > 0
    ? filteredJobRoles.slice(0, configuredLimit)
    : filteredJobRoles;

// ---------------------------------------
// Constants
// ---------------------------------------
const BASE_URL = "https://www.rozee.pk/job/jsearch/q/";
const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

// ---------------------------------------
// Helpers
// ---------------------------------------
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 500;
      const timer = setInterval(() => {
        const { scrollHeight } = document.body;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight - 2000) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });
}

function clean(value) {
  return value ? value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim() : "";
}

function extractListSection(html, title) {
  if (!html) {
    return [];
  }
  const pattern = new RegExp(
    `<b>${title.replace(/[-[\]/{}()*+?.\\^$|]/g, "\\$&")}<\\/b>([\\s\\S]*?)(<b>|$)`,
    "i"
  );
  const match = html.match(pattern);
  if (!match) {
    return [];
  }
  return match[1]
    .split(/<br\s*\/?>\s*-?/i)
    .map((entry) => entry.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function formatSalaryRange(minValue, maxValue, fallbackText) {
  const parsedMin = Number(minValue);
  const parsedMax = Number(maxValue);
  const hasMin = Number.isFinite(parsedMin) && parsedMin > 0;
  const hasMax = Number.isFinite(parsedMax) && parsedMax > 0;

  if (!hasMin && !hasMax) {
    return fallbackText ? String(fallbackText) : "";
  }

  const format = (value) =>
    Number(value).toLocaleString("en-PK", { maximumFractionDigits: 0 });

  if (hasMin && hasMax && parsedMin !== parsedMax) {
    return `PKR ${format(parsedMin)} - PKR ${format(parsedMax)}`;
  }

  const singleValue = hasMin ? parsedMin : parsedMax;
  return singleValue ? `PKR ${format(singleValue)}` : fallbackText || "";
}

function buildJobId(source) {
  if (!source) {
    return `rozee-${crypto.randomBytes(6).toString("hex")}`;
  }

  const sanitized = String(source).replace(/[^a-zA-Z0-9_-]/g, "");
  if (sanitized) {
    return `rozee-${sanitized}`;
  }

  const hash = crypto
    .createHash("sha1")
    .update(String(source))
    .digest("hex")
    .slice(0, 16);
  return `rozee-${hash}`;
}

function buildSearchUrl(role) {
  const normalizedRole = role.replace(/\s+/g, " ").trim();
  const encodedRole = encodeURIComponent(normalizedRole);
  return `${BASE_URL}${encodedRole}`;
}

// ---------------------------------------
// Detail page scraping (uses selectors from provided script)
// ---------------------------------------
async function scrapeDetailPage(browser, jobUrl) {
  if (!jobUrl) {
    return null;
  }

  let detailPage;
  try {
    detailPage = await browser.newPage();
    await detailPage.setUserAgent(DESKTOP_USER_AGENT);
    await detailPage.setDefaultNavigationTimeout(60000);
    await detailPage.setDefaultTimeout(60000);
    await detailPage.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await detailPage.waitForSelector("body", { timeout: 60000 });
    await sleep(500);

    return await detailPage.evaluate(() => {
      const getText = (selector) =>
        document.querySelector(selector)?.innerText?.replace(/\s+/g, " ").trim() || "";

      const jobDetailsTable = {};
      document.querySelectorAll(".jobd .row").forEach((row) => {
        const label = row.querySelector("b")?.innerText?.trim();
        const value = row.querySelector(".col-lg-7, .col-md-7, .col-sm-8")?.innerText?.trim();
        if (label && value) {
          jobDetailsTable[label] = value;
        }
      });

      const descriptionNode = document.querySelector("#jbDetail .jblk.ul18 p");
      const descriptionHtml = descriptionNode?.innerHTML || "";
      const jobDescription = descriptionNode?.innerText?.replace(/\s+/g, " ").trim() || "";

      const extractSection = (title) => {
        if (!descriptionHtml) {
          return [];
        }
          const escapeRegExp = (value = "") => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const escapedTitle = escapeRegExp(title);
        const pattern = new RegExp(
          '<b>' + escapedTitle + '<\\/b>([\\s\\S]*?)(<b>|$)',
          "i"
        );
        const match = descriptionHtml.match(pattern);
        if (!match) {
          return [];
        }
          return match[1]
            .split(/<br>-\s*/i)
            .slice(1)
            .map((item) => item.replace(/<br\s*\/?>(?=\s*-)/gi, " ").replace(/<br\s*\/?/gi, " ").replace(/<[^>]+>/g, " ").trim())
            .filter(Boolean);
      };

      const skills = (() => {
        const blocks = Array.from(document.querySelectorAll(".jblk"));
        for (const block of blocks) {
          const heading = block.querySelector("h4.font18");
          if (heading && heading.innerText.trim().toLowerCase() === "skills") {
            return Array.from(block.querySelectorAll(".jcnt a.label"))
              .map((node) => node.innerText.trim())
              .filter(Boolean);
          }
        }
        return [];
      })();

      return {
        title: getText("h1"),
        company: getText(".company-name, .company-title, .job-header .mb-0, .ctitle.font24 bdi"),
        location: getText(".location, .job-location, .job-header .mb-0+div"),
        posted: getText(".posted, .job-date, .job-header .text-muted"),
        views: getText(".views, .job-views"),
        jobDescription,
        aboutCompany: getText("#cmpDetail .mt10.font15 p, .about-company, .company-desc, .company-description"),
        keyResponsibilities: extractSection("Key Responsibilities"),
        requiredQualifications: extractSection("Required Qualifications"),
        preferredQualifications: extractSection("Preferred Qualifications and Benefits"),
        skills,
        jobDetails: jobDetailsTable,
        salaryDetail:
          getText("div.mrsl.mt10.ofa.font18.text-right.text-dark.d-flex.align-items-center") ||
          jobDetailsTable["Salary"] ||
          jobDetailsTable["Salary Range"] ||
          "",
        url: window.location.href
      };
    });
  } catch (err) {
    console.log(`⚠️  Unable to scrape Rozee detail page (${jobUrl}): ${err.message}`);
    return null;
  } finally {
    if (detailPage && !detailPage.isClosed()) {
      await detailPage.close();
    }
  }
}

function normalizeRozeeListing(role, listing, detail = {}) {
  if (!listing || !listing.title || !listing.link) {
    return null;
  }

  const salary = detail.salaryDetail?.trim()
    ? detail.salaryDetail.trim()
    : formatSalaryRange(listing.salaryMin, listing.salaryMax, listing.salaryText);

  const jobDetails = { ...(detail.jobDetails || {}) };
  if (detail.views) {
    jobDetails.Views = detail.views;
  }

  Object.keys(jobDetails).forEach((key) => {
    if (!jobDetails[key]) {
      delete jobDetails[key];
    }
  });

  const bulletSections = [];
  const makeSection = (title, entries) => {
    if (!Array.isArray(entries) || !entries.length) {
      return "";
    }
    return `${title}:\n${entries.map((item) => `- ${item}`).join("\n")}`;
  };

  const keyResponsibilitiesSection = makeSection(
    "Key Responsibilities",
    detail.keyResponsibilities
  );
  const requiredQualificationsSection = makeSection(
    "Required Qualifications",
    detail.requiredQualifications
  );
  const preferredQualificationsSection = makeSection(
    "Preferred Qualifications & Benefits",
    detail.preferredQualifications
  );
  if (keyResponsibilitiesSection) bulletSections.push(keyResponsibilitiesSection);
  if (requiredQualificationsSection) bulletSections.push(requiredQualificationsSection);
  if (preferredQualificationsSection) bulletSections.push(preferredQualificationsSection);
  if (detail.aboutCompany) {
    bulletSections.push(`About the Company:\n${detail.aboutCompany}`);
  }

  const descriptionFromDetail = (detail.jobDescription || "").replace(/\s+/g, " ").trim();
  const fallbackDescription = (listing.snippet || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const jobDescription = [descriptionFromDetail, ...bulletSections]
    .filter(Boolean)
    .join("\n\n") || fallbackDescription;

  const detailSkills = Array.isArray(detail.skills) ? detail.skills.filter(Boolean) : [];
  const preferredQualifications = Array.isArray(detail.preferredQualifications)
    ? detail.preferredQualifications.filter(Boolean)
    : [];
  const benefits = Array.from(new Set([...detailSkills, ...preferredQualifications])).filter(Boolean);

  return {
    searchRole: role,
    jobId: buildJobId(listing.listingId || listing.link),
    jobRole: (detail.title || listing.title || "").trim(),
    companyName: detail.company || listing.company || "",
    companyProfileUrl: listing.companyLink || "",
    applyNowUrl: listing.link,
    externalApplyUrl: "",
    detailUrl: listing.link,
    location: detail.location || listing.city || listing.location || "",
    salary,
    postedAt: detail.posted || listing.postedAt || "",
    jobDetails,
    benefits,
    jobDescription,
    experience: jobDetails["Minimum Experience"] || "",
    education: jobDetails["Minimum Education"] || "",
    scrapedAt: new Date().toISOString()
  };
}

// ---------------------------------------
// Role search results scraping
// ---------------------------------------
async function scrapeRole(browser, page, role) {
  const url = buildSearchUrl(role);
  console.log(`🌐 Navigating to Rozee.pk: ${url}`);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await autoScroll(page);
  await sleep(1000);

  try {
    await page.waitForSelector(".job", { timeout: 60000 });
  } catch (err) {
    console.log("⚠️  Unable to find Rozee.pk listings on the search page.");
    return [];
  }

  const listings = await page.evaluate(() => {
    const base = window.location.origin || "https://www.rozee.pk";
    const toAbsoluteUrl = (value) => {
      if (!value) {
        return "";
      }
      if (value.startsWith("//")) {
        return `${window.location.protocol}${value}`;
      }
      try {
        return new URL(value, base).href;
      } catch (err) {
        return value;
      }
    };

    const pickText = (root, selectors) => {
      for (const selector of selectors) {
        const node = root.querySelector(selector);
        const text = node?.innerText?.replace(/\s+/g, " ").trim();
        if (text) {
          return text;
        }
      }
      return "";
    };

    return Array.from(document.querySelectorAll(".job"))
      .map((card) => {
        const anchor = card.querySelector("h3.s-18 a");
        const href = anchor?.getAttribute("href") || anchor?.href || "";
        const link = toAbsoluteUrl(href);
        const title = anchor?.innerText?.trim() || "";

        return {
          listingId: link || title,
          link,
          title,
          company: pickText(card, [
            ".text-muted.h6",
            ".company-name",
            "p.text-muted",
            "small.text-muted"
          ]),
          city: pickText(card, [
            ".job-location",
            ".icon-location",
            "li[title*='Location']",
            ".text-muted small"
          ]),
          location: pickText(card, [
            ".job-location",
            ".icon-location",
            "li[title*='Location']",
            ".text-muted small"
          ]),
          salaryText: pickText(card, [
            ".text-success",
            ".salary",
            "li[title*='Salary']"
          ]),
          postedAt: pickText(card, [".posted", ".job-date", "time", "small.text-muted"]),
          snippet: pickText(card, [
            ".job-desc",
            ".jbody",
            "p",
            ".job-detail"
          ])
        };
      })
      .filter((entry) => entry.title && entry.link);
  });

  console.log(`✔ Found ${listings.length} Rozee.pk jobs for: ${role}`);

  if (!listings.length) {
    return [];
  }

  const limitedListings =
    Number.isFinite(configuredJobResultLimit) && configuredJobResultLimit > 0
      ? listings.slice(0, configuredJobResultLimit)
      : listings;

  if (limitedListings.length < listings.length) {
    console.log(
      `🔢 Limiting to first ${limitedListings.length} job(s) for: ${role} on Rozee.pk`
    );
  }

  const normalizedJobs = [];

  for (const [index, listing] of limitedListings.entries()) {
    let detail = null;
    if (listing.link) {
      detail = await scrapeDetailPage(browser, listing.link);
      await sleep(500);
    }

    const normalized = normalizeRozeeListing(role, listing, detail || {});
    if (normalized) {
      normalizedJobs.push(normalized);
    } else {
      console.log(`⚠️  Skipping malformed Rozee.pk listing at position ${index + 1}`);
    }
  }

  if (!normalizedJobs.length) {
    console.log("⚠️  No Rozee.pk jobs could be normalized for persistence.");
  }

  return normalizedJobs;
}

// ---------------------------------------
// Entry point mirroring IndeedScraper
// ---------------------------------------
async function scrapeRoles(requestedRoles = null) {
  const roles =
    Array.isArray(requestedRoles) && requestedRoles.length
      ? requestedRoles
      : rolesToScrape;

  if (!roles.length) {
    console.log("No job roles to scrape for Rozee.pk.");
    return [];
  }

  const allSavedJobs = [];
  let browser;
  let searchPage;

  try {
    browser = await puppeteer.launch({
      headless: process.env.HEADLESS !== "false",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    searchPage = await browser.newPage();
    await searchPage.setUserAgent(DESKTOP_USER_AGENT);
    await searchPage.setDefaultNavigationTimeout(60000);
    await searchPage.setDefaultTimeout(60000);

    for (const role of roles) {
      console.log(`\n🔍 Scraping Rozee.pk role: ${role}`);

      try {
        const roleJobs = await scrapeRole(browser, searchPage, role);
        if (!roleJobs.length) {
          console.log(`⏭️  No Rozee.pk jobs collected for ${role}.`);
          continue;
        }

        const savedJobs = await persistRoleJobs(role, roleJobs);
        allSavedJobs.push(...savedJobs);

        await sleep(2000);
      } catch (err) {
        console.log(`❌ Error scraping Rozee.pk role ${role}: ${err.message}`);
      }
    }
  } finally {
    if (searchPage && !searchPage.isClosed()) {
      await searchPage.close();
    }
    if (browser) {
      await browser.close();
    }
  }

  console.log("\n🏁 Rozee.pk scraping complete!");
  console.log(`📊 Total new Rozee.pk jobs saved to MongoDB: ${allSavedJobs.length}`);
  return allSavedJobs;
}

module.exports = {
  scrapeRoles,
  jobRoles
};
