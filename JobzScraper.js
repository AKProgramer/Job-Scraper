const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const crypto = require("crypto");
const { persistRoleJobs, sleep } = require("./scraperShared");

// ---------------------------------------
// Role configuration (shared with other scrapers)
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
  process.env.JOB_SCRAPER_RESULTS_PER_ROLE || "5",
  10
);
const rolesToScrape =
  Number.isFinite(configuredLimit) && configuredLimit > 0
    ? filteredJobRoles.slice(0, configuredLimit)
    : filteredJobRoles;

// ---------------------------------------
// Constants
// ---------------------------------------
const BASE_URL = "https://www.jobz.pk";
const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
const LISTING_SELECTOR = "div.row_container";
const JOBZ_EXPORT_DIR = path.join(__dirname, "jobs", "jobz_raw");

if (!fs.existsSync(JOBZ_EXPORT_DIR)) {
  fs.mkdirSync(JOBZ_EXPORT_DIR, { recursive: true });
}

function normalizeText(value) {
  if (!value) {
    return "";
  }
  return String(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function buildJobzJobId(link) {
  if (!link) {
    return `jobz-${crypto.randomBytes(6).toString("hex")}`;
  }

  const directMatch = link.match(/jobs?-([0-9]+)/i);
  if (directMatch?.[1]) {
    return `jobz-${directMatch[1]}`;
  }

  const sanitized = link
    .replace(/^https?:\/\//i, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-40);

  if (sanitized) {
    return `jobz-${sanitized}`;
  }

  return `jobz-${crypto.randomBytes(6).toString("hex")}`;
}

async function loadJobzSearchResults(page, role) {
  console.log(`🔍 Searching Jobz.pk for: ${role}`);
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('input[name="str"]', { timeout: 20000 });

  await page.evaluate((searchRole) => {
    const input = document.querySelector('input[name="str"]');
    if (input) {
      input.value = searchRole;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, role);

  await Promise.all([
    page.click('input[type="submit"][value="Search"]'),
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 })
  ]);

  await sleep(1500);
}

async function collectSearchListings(page) {
  return page.evaluate(() => {
    const normalize = (value) =>
      value ? value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim() : "";

    const toAbsoluteUrl = (href) => {
      if (!href) {
        return "";
      }
      if (/^https?:/i.test(href)) {
        return href;
      }
      if (href.startsWith("//")) {
        return `${window.location.protocol}${href}`;
      }
      if (href.startsWith("/")) {
        return `${window.location.origin}${href}`;
      }
      return `${window.location.origin}/${href}`;
    };

    const listings = [];

    document.querySelectorAll("div.row_container").forEach((row) => {
      if (row.querySelector(".color_top_text")) {
        return;
      }

      const cell1 = row.querySelector(".cell1");
      const cell2 = row.querySelector(".cell2");
      const cell3 = row.querySelector(".cell3");
      const cell4 = row.querySelector(".cell4");

      const titleAnchor = cell1 ? cell1.querySelector("a") : null;
      if (!titleAnchor) {
        return;
      }

      const title = normalize(titleAnchor.innerText);
      const link = toAbsoluteUrl(titleAnchor.getAttribute("href") || titleAnchor.href || "");
      if (!title || !link) {
        return;
      }

      const snippetNode = cell1?.querySelector("p:last-of-type") || cell1?.querySelector("p");
      const vacantCell = row.querySelector('div.cell1[style*="width:100%"]');
      const vacantPositions = vacantCell
        ? Array.from(vacantCell.querySelectorAll("a"))
            .map((anchor) => normalize(anchor.innerText))
            .filter(Boolean)
        : [];

      const date = normalize(cell4?.innerText || "");

      listings.push({
        listingId: link,
        link,
        title,
        industry: normalize(cell2?.innerText || ""),
        city: normalize(cell3?.innerText || ""),
        date,
        postedAt: date,
        snippet: normalize(snippetNode?.innerText || ""),
        vacantPositions
      });
    });

    return listings;
  });
}

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
      const normalize = (value) =>
        value ? value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim() : "";

      const detailRows = Array.from(document.querySelectorAll(".job_detail .row_job_detail"));
      const detailMap = {};

      detailRows.forEach((row) => {
        const keyNode = row.querySelector(".job_detail_cell1") || row.querySelector("b");
        const valueNode = row.querySelector(".job_detail_cell2") || row.querySelector(":scope > div:last-child");

        const key = normalize((keyNode?.innerText || "").replace(/:$/, ""));
        if (!key) {
          return;
        }

        if (valueNode) {
          const anchor = valueNode.querySelector("a[href]");
          if (anchor) {
            detailMap[key] = {
              text: normalize(anchor.innerText || anchor.href),
              href: anchor.href
            };
            return;
          }
          detailMap[key] = normalize(valueNode.innerText || "");
          return;
        }

        detailMap[key] = normalize(row.innerText || "");
      });

      const pickText = (selectors) => {
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          const text = normalize(node?.innerText || "");
          if (text) {
            return text;
          }
        }
        return "";
      };

      const collectList = (rootSelectors) => {
        const values = [];
        rootSelectors.forEach((selector) => {
          document.querySelectorAll(selector).forEach((node) => {
            node.querySelectorAll("li").forEach((item) => {
              const text = normalize(item.innerText);
              if (text) {
                values.push(text);
              }
            });
          });
        });
        return Array.from(new Set(values));
      };

      const descriptionText = pickText([
        ".job-description",
        ".job_desc",
        ".job_detail_pages",
        ".job_detail .col-md-8",
        "#jobDetail",
        ".job_detail .job_detail_text"
      ]);

      return {
        title: pickText(["h1", ".job_detail h1", ".heading h1"]),
        company: detailMap["Organization"] || pickText([".company-title", ".heading h2"]),
        jobDescription: descriptionText,
        bulletHighlights: collectList([
          ".job-description",
          ".job_desc",
          ".job_detail_pages",
          ".job_detail"
        ]),
        detailMap
      };
    });
  } catch (err) {
    console.log(`⚠️  Unable to scrape Jobz.pk detail page (${jobUrl}): ${err.message}`);
    return null;
  } finally {
    if (detailPage && !detailPage.isClosed()) {
      await detailPage.close();
    }
  }
}

function parseLinkCell(value) {
  if (!value) {
    return { text: "", href: "" };
  }

  if (typeof value === "string") {
    return { text: value, href: "" };
  }

  return {
    text: value.text || "",
    href: value.href || ""
  };
}

function extractStructuredDetail(detailMap = {}) {
  const valueToText = (value) => {
    if (!value) {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    return value.text || value.href || "";
  };

  return {
    applyOnline: parseLinkCell(detailMap["Apply Online if applicable"]),
    whatsAppChannel: parseLinkCell(detailMap["WhatsApp Channel"]),
    onlineApplicants: valueToText(detailMap["Online Applicants"]),
    datePosted: valueToText(detailMap["Date Posted / Updated"]),
    category: valueToText(detailMap["Category / Sector"]),
    newspaper: valueToText(detailMap["Newspaper"]),
    education: valueToText(detailMap["Education"]),
    areaTown: valueToText(detailMap["Area / Town"]),
    vacancyLocation: valueToText(detailMap["Vacancy Location"]),
    organization: valueToText(detailMap["Organization"]),
    jobIndustry: valueToText(detailMap["Job Industry"]),
    jobType: valueToText(detailMap["Job Type"]),
    expectedLastDate: valueToText(detailMap["Expected Last Date"])
  };
}

function buildJobDescription(listing, detail, structuredDetail = null) {
  const sections = [];

  if (detail?.jobDescription) {
    sections.push(detail.jobDescription);
  }

  if (Array.isArray(detail?.bulletHighlights) && detail.bulletHighlights.length) {
    const highlightBlock = detail.bulletHighlights
      .map((item) => `- ${item}`)
      .join("\n");
    sections.push(`Key Highlights:\n${highlightBlock}`);
  }

  if (Array.isArray(listing?.vacantPositions) && listing.vacantPositions.length) {
    const positionsBlock = listing.vacantPositions.map((item) => `- ${item}`).join("\n");
    sections.push(`Vacant Positions:\n${positionsBlock}`);
  }

  const detailMap = detail?.detailMap || {};
  const structured = structuredDetail || extractStructuredDetail(detailMap);
  const extraInfo = [];

  const whatsapp = structured.whatsAppChannel;
  if (whatsapp.text || whatsapp.href) {
    extraInfo.push(
      whatsapp.href
        ? `WhatsApp Channel: ${whatsapp.text || whatsapp.href} (${whatsapp.href})`
        : `WhatsApp Channel: ${whatsapp.text}`
    );
  }

  if (structured.onlineApplicants) {
    extraInfo.push(`Online Applicants: ${structured.onlineApplicants}`);
  }

  const applyInfo = structured.applyOnline;
  if (applyInfo.text || applyInfo.href) {
    extraInfo.push(
      applyInfo.href
        ? `Apply Online: ${applyInfo.text || applyInfo.href} (${applyInfo.href})`
        : `Apply Online: ${applyInfo.text}`
    );
  }

  if (structured.newspaper) {
    extraInfo.push(`Newspaper: ${structured.newspaper}`);
  }

  if (extraInfo.length) {
    sections.push(extraInfo.join("\n"));
  }

  if (sections.length) {
    return sections.join("\n\n");
  }

  return listing?.snippet || "";
}

function normalizeJobzListing(role, listing, detail = {}) {
  if (!listing?.title || !listing?.link) {
    return null;
  }

  const detailMap = detail.detailMap || {};
  const structuredDetail = extractStructuredDetail(detailMap);

  const filteredJobDetails = Object.fromEntries(
    Object.entries({
      jobIndustry: structuredDetail.jobIndustry || listing.industry || "",
      jobType: structuredDetail.jobType || "",
      functionalArea: structuredDetail.category || "",
      totalPositions:
        detailMap["Vacancy"] ||
        detailMap["Total Positions"] ||
        (Array.isArray(listing.vacantPositions) && listing.vacantPositions.length
          ? String(listing.vacantPositions.length)
          : ""),
      gender: detailMap["Gender"] || "",
      careerLevel: detailMap["Career Level"] || "",
      applyBefore: structuredDetail.expectedLastDate || "",
      postingDate:
        structuredDetail.datePosted || listing.date || listing.postedAt || "",
      workplaceType: structuredDetail.vacancyLocation || "",
      workSetting: structuredDetail.areaTown || "",
      compensationDetails: detailMap["Salary"] || detailMap["Salary Range"] || ""
    }).filter(([, value]) => normalizeText(value))
  );

  const applyInfo = structuredDetail.applyOnline;
  const applyNowUrl = applyInfo.href || listing.link;
  const externalApplyUrl = applyInfo.href && !applyInfo.href.startsWith(BASE_URL) ? applyInfo.href : "";

  const benefitsSource = detailMap["Facilities"] || detailMap["Benefits"];
  const benefits = Array.isArray(benefitsSource)
    ? benefitsSource.filter(Boolean)
    : typeof benefitsSource === "string"
    ? benefitsSource
        .split(/,|;|\n/)
        .map((item) => normalizeText(item))
        .filter(Boolean)
    : [];

  return {
    searchRole: role,
    jobId: buildJobzJobId(listing.link),
    jobRole: detail.title || listing.title,
    companyName:
      structuredDetail.organization || detail.company || detailMap["Organization"] || "",
    companyProfileUrl:
      typeof detailMap["Organization Website"] === "string"
        ? detailMap["Organization Website"]
        : detailMap["Organization Website"]?.href || "",
    applyNowUrl,
    externalApplyUrl,
    detailUrl: listing.link,
    location:
      structuredDetail.vacancyLocation ||
      structuredDetail.areaTown ||
      listing.city ||
      "",
    salary:
      detailMap["Salary"] ||
      detailMap["Salary Range"] ||
      detailMap["Pay"] ||
      "",
    postedAt:
      structuredDetail.datePosted || listing.date || listing.postedAt || "",
    jobDetails: filteredJobDetails,
    benefits,
    jobDescription: buildJobDescription(listing, detail, structuredDetail),
    experience: detailMap["Experience"] || detailMap["Experience Level"] || "",
    education: structuredDetail.education || "",
    scrapedAt: new Date().toISOString()
  };
}

function saveJobSnapshot(job) {
  if (!job || !job.jobRole) {
    return;
  }

  const safeTitle = job.jobRole.replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, 40) || "job";
  const safeIdSource = job.jobId || job.detailUrl || `${Date.now()}`;
  const safeId = safeIdSource.replace(/[^a-z0-9_-]+/gi, "").slice(-40) || `${Date.now()}`;
  const fileName = `${safeTitle}_${safeId}.json`;

  try {
    fs.writeFileSync(path.join(JOBZ_EXPORT_DIR, fileName), JSON.stringify(job, null, 2));
  } catch (err) {
    console.log(`⚠️  Unable to save Jobz.pk snapshot ${fileName}: ${err.message}`);
  }
}

async function scrapeRole(browser, page, role) {
  await loadJobzSearchResults(page, role);
  await sleep(1000);

  try {
    await page.waitForSelector(LISTING_SELECTOR, { timeout: 15000 });
  } catch (err) {
    console.log("⚠️  Jobz.pk listings did not render within the expected time window.");
  }

  const listings = await collectSearchListings(page);
  console.log(`✔ Found ${listings.length} Jobz.pk jobs for: ${role}`);

  if (!listings.length) {
    return [];
  }

  const limitedListings =
    Number.isFinite(configuredJobResultLimit) && configuredJobResultLimit > 0
      ? listings.slice(0, configuredJobResultLimit)
      : listings;

  if (limitedListings.length < listings.length) {
    console.log(
      `🔢 Limiting to first ${limitedListings.length} job(s) for: ${role} on Jobz.pk`
    );
  }

  const normalizedJobs = [];

  for (const [index, listing] of limitedListings.entries()) {
    let detail = null;

    if (listing.link) {
      detail = await scrapeDetailPage(browser, listing.link);
      await sleep(500);
    }

    const normalized = normalizeJobzListing(role, listing, detail || {});
    if (normalized) {
      saveJobSnapshot(normalized);
      normalizedJobs.push(normalized);
    } else {
      console.log(`⚠️  Skipping malformed Jobz.pk listing at position ${index + 1}`);
    }
  }

  if (!normalizedJobs.length) {
    console.log("⚠️  No Jobz.pk jobs could be normalized for persistence.");
  }

  return normalizedJobs;
}

async function scrapeRoles(requestedRoles = null) {
  const roles =
    Array.isArray(requestedRoles) && requestedRoles.length
      ? requestedRoles
      : rolesToScrape;

  if (!roles.length) {
    console.log("No job roles to scrape for Jobz.pk.");
    return [];
  }

  const allSavedJobs = [];
  let browser;
  let searchPage;

  try {
    browser = await puppeteer.launch({
      headless: process.env.HEADLESS !== "true",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    searchPage = await browser.newPage();
    await searchPage.setUserAgent(DESKTOP_USER_AGENT);
    await searchPage.setDefaultNavigationTimeout(60000);
    await searchPage.setDefaultTimeout(60000);

    for (const role of roles) {
      console.log(`\n🔍 Scraping Jobz.pk role: ${role}`);

      try {
        const roleJobs = await scrapeRole(browser, searchPage, role);
        if (!roleJobs.length) {
          console.log(`⏭️  No Jobz.pk jobs collected for ${role}.`);
          continue;
        }

        const savedJobs = await persistRoleJobs(role, roleJobs);
        allSavedJobs.push(...savedJobs);

        await sleep(2000);
      } catch (err) {
        console.log(`❌ Error scraping Jobz.pk role ${role}: ${err.message}`);
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

  console.log("\n🏁 Jobz.pk scraping complete!");
  console.log(`📊 Total new Jobz.pk jobs saved to MongoDB: ${allSavedJobs.length}`);
  return allSavedJobs;
}

module.exports = {
  scrapeRoles,
  jobRoles
};

if (require.main === module) {
  const rolesFromArgs = process.argv
    .slice(2)
    .map((role) => role.trim())
    .filter(Boolean);

  scrapeRoles(rolesFromArgs).catch((err) => {
    console.error("Unhandled error:", err);
    process.exit(1);
  });
}
