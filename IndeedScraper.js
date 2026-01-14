const fs = require("fs");
const path = require("path");

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const { extractJobId, persistRoleJobs, sleep } = require("./scraperShared");

// ---------------------------------------
// Role configuration
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
const BASE_URL = "https://www.indeed.com/jobs?q=";
const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
const OUTPUT_DIR = path.join(__dirname, "jobs");
const DEBUG_DIR = path.join(__dirname, "debug_snapshots");

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

if (!fs.existsSync(DEBUG_DIR)) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
}

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

async function pause(page, durationMs) {
  if (page && typeof page.waitForTimeout === "function") {
    await page.waitForTimeout(durationMs);
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function clickIfVisible(page, selector, options = {}) {
  try {
    await page.waitForSelector(selector, { timeout: 2500, visible: true });
  } catch (err) {
    return false;
  }

  const handle = await page.$(selector);
  if (!handle) {
    return false;
  }

  try {
    await handle.click({ delay: 30, ...options });
    await sleep(400);
    return true;
  } catch (err) {
    return false;
  }
}

async function dismissConsentAndPopups(page) {
  const selectors = [
    "#onetrust-accept-btn-handler",
    "button#onetrust-accept-btn-handler",
    "button[data-testid='close-modal']",
    "button[aria-label='Close']",
    "button[aria-label='Dismiss']",
    "button.icl-CloseButton",
    "div[role='dialog'] button[data-testid='close']"
  ];

  for (const selector of selectors) {
    await clickIfVisible(page, selector);
  }
}

async function saveDebugSnapshot(page, role, label) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeRole = (role || "role").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "role";
  const safeLabel = (label || "snapshot").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "snapshot";
  const baseName = `${safeRole}-${safeLabel}-${timestamp}`;

  try {
    const htmlPath = path.join(DEBUG_DIR, `${baseName}.html`);
    const htmlContent = await page.content();
    fs.writeFileSync(htmlPath, htmlContent, "utf8");
    console.log(`🕵️ Saved debug HTML: ${htmlPath}`);
  } catch (err) {
    console.log(`⚠️ Unable to save debug HTML: ${err.message}`);
  }

  try {
    const screenshotPath = path.join(DEBUG_DIR, `${baseName}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`🕵️ Saved debug screenshot: ${screenshotPath}`);
  } catch (err) {
    console.log(`⚠️ Unable to capture debug screenshot: ${err.message}`);
  }
}

const ALT_APPLICATION_TEXT = /if you require alternative methods/i;

function normalizePostedAt(primary, fallback) {
  if (primary && !ALT_APPLICATION_TEXT.test(primary)) {
    return primary;
  }
  return fallback || "";
}

// ---------------------------------------
// Detail page scraping
// ---------------------------------------
async function enrichJobDetails(browser, baseJob, searchRole) {
  const detailPage = await browser.newPage();
  await detailPage.setUserAgent(DESKTOP_USER_AGENT);

  try {
    await detailPage.goto(baseJob.link, {
      waitUntil: "networkidle2",
      timeout: 0
    });
    await sleep(1500);

    const detail = await detailPage.evaluate(() => {
      const text = (selector) =>
        document.querySelector(selector)?.innerText?.trim() || "";
      const href = (selector) => document.querySelector(selector)?.href || "";

      const collectJoinedText = (selectors) => {
        for (const selector of selectors) {
          const nodes = Array.from(document.querySelectorAll(selector));
          const combined = nodes
            .map((node) =>
              node.innerText
                .replace(/\u00a0|&nbsp;/g, " ")
                .replace(/\s+/g, " ")
                .trim()
            )
            .filter(Boolean)
            .join(" • ");
          if (combined) {
            return combined;
          }
        }
        return "";
      };

      const descriptionElement =
        document.querySelector("[data-testid='jobDescription']") ||
        document.querySelector("#jobDescriptionText");
      const jobDescription = descriptionElement?.innerText?.trim() || "";

      const collectDetailMap = () => {
        const map = {};
        const sections = document.querySelectorAll(
          "[data-testid='jobDetailsSection'], #jobDetailsSection"
        );
        sections.forEach((section) => {
          section.querySelectorAll("div, li, dl").forEach((node) => {
            const headingNode = node.querySelector(
              "h3, h4, span[title], dt, strong"
            );
            const heading = headingNode?.innerText?.trim() || "";
            let value = node.innerText?.trim() || "";
            if (heading && value.startsWith(heading)) {
              value = value.slice(heading.length).trim();
            }
            if (heading && value) {
              map[heading] = value;
            }
          });
        });
        return map;
      };

      const detailSections = collectDetailMap();

      const deriveDetail = (keys) => {
        for (const key of keys) {
          if (detailSections[key]) {
            return detailSections[key];
          }
        }
        return "";
      };

      const benefitsSet = new Set(
        Array.from(
          document.querySelectorAll(
            "[data-testid='benefitsSection'] li, .css-727s.eu4oa1w0, .css-727s"
          )
        )
          .map((node) =>
            node.innerText
              .replace(/\u00a0|&nbsp;/g, " ")
              .replace(/\s+/g, " ")
              .trim()
          )
          .filter(Boolean)
      );

      const benefits = Array.from(benefitsSet)
        .flatMap((entry) => entry.split(/\n+/))
        .map((item) =>
          item
            .replace(/\u00a0|&nbsp;/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        )
        .filter(
          (item) =>
            item &&
            !/^benefits$/i.test(item) &&
            !/pulled from the full job description/i.test(item)
        );

      const applyAnchor =
        document.querySelector("a[data-testid='indeed-apply-button']") ||
        document.querySelector("a[data-indeed-apply-url]");
      const applyNowUrl = applyAnchor?.href || "";

      const externalApplyAnchor = Array.from(
        document.querySelectorAll("a[href]")
      ).find((anchor) => {
        const textContent = anchor.innerText.trim().toLowerCase();
        return anchor.href && /apply/.test(textContent) && anchor.href !== applyNowUrl;
      });

      const descriptionItems = Array.from(
        (descriptionElement || document).querySelectorAll("li")
      )
        .map((li) => li.innerText.trim())
        .filter(Boolean);

      const experienceText =
        deriveDetail(["Experience", "Experience level", "Experience Level"]) ||
        descriptionItems.find((item) => /experience/.test(item.toLowerCase())) ||
        "";

      const educationText =
        deriveDetail(["Education", "Education level", "Education Level"]) ||
        descriptionItems.find((item) =>
          /(degree|diploma|education)/.test(item.toLowerCase())
        ) ||
        "";

      const jobDetails = {
        jobType: deriveDetail(["Job type", "Job Type"]) || "",
        shiftAndSchedule:
          deriveDetail(["Shift and schedule", "Shift & schedule", "Schedule"]) ||
          "",
        workSetting: deriveDetail(["Work setting", "Work Setting"]) || "",
        workplaceType: deriveDetail(["Workplace type", "Workplace Type"]) || "",
        compensationDetails:
          deriveDetail(["Compensation", "Compensation & benefits"]) || "",
        contractType: deriveDetail(["Contract type", "Contract Type"]) || "",
        securityClearance:
          deriveDetail(["Security clearance", "Security Clearance"]) || "",
        travelRequirement:
          deriveDetail(["Travel requirement", "Travel requirements"]) || ""
      };

      const location = collectJoinedText([
        "[data-testid='inlineHeader-companyLocation'] span",
        "[data-testid='inlineHeader-companyLocation']",
        "[data-company-location='true']",
        ".css-1wbl7v6.eu4oa1w0",
        "[data-testid='jobsearch-JobInfoHeader-subtitle'] div:last-child",
        ".jobsearch-JobInfoHeader-subtitle div:last-child"
      ]);

      const salary =
        deriveDetail(["Pay", "Salary", "Compensation"]) ||
        collectJoinedText([
          "[data-testid='salarySection']",
          "[data-testid='detailSalary']"
        ]);

      const postedAt = collectJoinedText([
        "[data-testid='jobsearch-JobMetadataFooter'] li",
        "[data-testid='jobsearch-JobMetadataFooter'] span",
        "[data-testid='jobsearch-JobMetadataFooter']",
        ".jobsearch-JobMetadataFooter"
      ]);

      return {
        title:
          text("[data-testid='jobsearch-JobInfoHeader-title']") || text("h1"),
        companyName:
          text("[data-company-name='true']") ||
          text(".jobsearch-InlineCompanyRating div:first-child") ||
          text(".css-qcqa6h.e1wnkr790"),
        location,
        salary,
        postedAt,
        companyProfileUrl:
          href("[data-testid='companyLink']") ||
          href(".jobsearch-InlineCompanyRating a") ||
          href(".css-qcqa6h.e1wnkr790 a") ||
          href("a[data-company-name='true']") ||
          "",
        jobDescription,
        benefits,
        experience: experienceText,
        education: educationText,
        jobDetails,
        applyNowUrl,
        externalApplyUrl: externalApplyAnchor?.href || ""
      };
    });

    return {
      searchRole,
      jobId: extractJobId(baseJob.link),
      jobRole: detail.title || baseJob.title,
      companyName: detail.companyName || baseJob.company,
      companyProfileUrl: detail.companyProfileUrl || "",
      applyNowUrl: detail.applyNowUrl || detail.externalApplyUrl || baseJob.link,
      externalApplyUrl: detail.externalApplyUrl || "",
      location: detail.location || baseJob.location,
      salary: detail.salary || baseJob.salaryOnCard || "",
      postedAt: normalizePostedAt(detail.postedAt, baseJob.postedAt),
      jobDetails: Object.fromEntries(
        Object.entries({
          jobType: detail.jobDetails.jobType || "",
          shiftAndSchedule: detail.jobDetails.shiftAndSchedule || "",
          workSetting: detail.jobDetails.workSetting || "",
          workplaceType: detail.jobDetails.workplaceType || "",
          compensationDetails: detail.jobDetails.compensationDetails || "",
          contractType: detail.jobDetails.contractType || "",
          securityClearance: detail.jobDetails.securityClearance || "",
          travelRequirement: detail.jobDetails.travelRequirement || ""
        }).filter(([, value]) => value)
      ),
      benefits: detail.benefits,
      jobDescription: detail.jobDescription,
      experience: detail.experience,
      education: detail.education,
      detailUrl: baseJob.link,
      scrapedAt: new Date().toISOString()
    };
  } catch (err) {
    return {
      searchRole,
      jobId: extractJobId(baseJob.link),
      jobRole: baseJob.title,
      companyName: baseJob.company,
      companyProfileUrl: "",
      applyNowUrl: baseJob.link,
      externalApplyUrl: "",
      location: baseJob.location,
      salary: baseJob.salaryOnCard || "",
      postedAt: normalizePostedAt("", baseJob.postedAt),
      jobDetails: {},
      benefits: [],
      jobDescription: "",
      experience: "",
      education: "",
      detailUrl: baseJob.link,
      scrapedAt: new Date().toISOString(),
      error: err.message
    };
  } finally {
    await detailPage.close();
  }
}

// ---------------------------------------
// Role search results scraping
// ---------------------------------------
async function scrapeRole(page, role) {
  const url = BASE_URL + encodeURIComponent(role);
  console.log(`🌐 Navigating to: ${url}`);

  await page.goto(url, { waitUntil: "networkidle2", timeout: 0 });
  await dismissConsentAndPopups(page);
  await pause(page, 1500);
  await autoScroll(page);
  await sleep(2000);
  await dismissConsentAndPopups(page);

  const jobAnchorSelector = "a[data-testid='jobTitle'], a.jcs-JobTitle, a[data-jk], a[data-mobtk], a.tapItem";
  try {
    await page.waitForSelector(jobAnchorSelector, { timeout: 15000 });
  } catch (err) {
    console.log("⚠️  Job cards did not render within timeout. Continuing anyway.");
  }

  const jobs = await page.evaluate(() => {
    const results = [];

    const getFallbackText = (root, selectors) => {
      for (const selector of selectors) {
        const node = root.querySelector(selector);
        const text = node?.innerText?.replace(/\s+/g, " ").trim();
        if (text) {
          return text;
        }
      }
      return "";
    };

    const anchorSelectors = [
      "a[data-testid='jobTitle']",
      "a[data-jk]",
      "a[data-mobtk]",
      "a.jcs-JobTitle",
      "a.tapItem",
      "h2.jobTitle a"
    ];

    const anchors = new Set();
    anchorSelectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((anchor) => anchors.add(anchor));
    });

    const seenLinks = new Set();

    anchors.forEach((anchor) => {
      const card =
        anchor.closest("div.job_seen_beacon") ||
        anchor.closest("div.cardOutline") ||
        anchor.closest("div.resultContent") ||
        anchor.closest("div.jobCard_mainContent") ||
        anchor.closest("li") ||
        anchor;

      const title =
        anchor.getAttribute("aria-label")?.trim() ||
        anchor.innerText?.trim() ||
        getFallbackText(card, ["h2.jobTitle", "span.jobTitle"]);

      if (!title) {
        return;
      }

      let link = anchor.href || "";
      if (link && !/^https?:/i.test(link)) {
        link = `https://www.indeed.com${link}`;
      }

      if (!link || seenLinks.has(link)) {
        return;
      }

      seenLinks.add(link);

      const company = getFallbackText(card, [
        "span.companyName",
        "a.companyOverviewLink",
        "span[data-testid='company-name']",
        "div.companyInfo",
        "div[data-testid='company-name']"
      ]);

      const location = getFallbackText(card, [
        "div.companyLocation",
        "div[data-testid='text-location']",
        "span[data-testid='location']",
        "div[data-testid='result-footer'] span"
      ]);

      const snippet = getFallbackText(card, [
        "div.job-snippet",
        "ul.job-snippet",
        "div[data-testid='job-snippet']",
        "div[data-testid='jobcard-descriptions']"
      ]);

      const salaryOnCard = getFallbackText(card, [
        "div.salary-snippet-container",
        "div[data-testid='attribute_snippet']",
        "div[data-testid='detailSalary']",
        "span[data-testid='salary-snippet']"
      ]);

      const postedAt = getFallbackText(card, [
        "span.date",
        "span[data-testid='myJobsStateDate']",
        "li[data-testid='myJobsStateDate']",
        "div[data-testid='result-footer'] span"
      ]);

      results.push({
        title,
        company,
        location,
        snippet,
        salaryOnCard,
        postedAt,
        link
      });
    });

    return results;
  });

  console.log(`✔ Found ${jobs.length} jobs for: ${role}`);

  if (!jobs.length) {
    console.log("⚠️  Indeed returned zero job cards. Saving debug snapshot for analysis.");
    try {
      await saveDebugSnapshot(page, role, "no-results");
    } catch (snapshotErr) {
      console.log(`⚠️  Failed to capture debug snapshot: ${snapshotErr.message}`);
    }
  }

  const limitedJobs =
    Number.isFinite(configuredJobResultLimit) && configuredJobResultLimit > 0
      ? jobs.slice(0, configuredJobResultLimit)
      : jobs;

  if (limitedJobs.length < jobs.length) {
    console.log(
      `🔢 Limiting to first ${limitedJobs.length} job(s) for: ${role}`
    );
  }

  return limitedJobs;
}

// ---------------------------------------
// Main entry point
// ---------------------------------------
async function scrapeRoles(requestedRoles = null) {
  const roles =
    Array.isArray(requestedRoles) && requestedRoles.length
      ? requestedRoles
      : rolesToScrape;

  if (!roles.length) {
    console.log("No job roles to scrape.");
    return [];
  }

  const allSavedJobs = [];
  let browser;
  let searchPage;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    searchPage = await browser.newPage();
    await searchPage.setUserAgent(DESKTOP_USER_AGENT);

    for (const role of roles) {
      console.log(`\n🔍 Scraping role: ${role}`);

      try {
        const summaryJobs = await scrapeRole(searchPage, role);
        const detailedJobs = [];

        for (const job of summaryJobs) {
          try {
            const detailedJob = await enrichJobDetails(browser, job, role);
            detailedJobs.push(detailedJob);
            console.log(
              `📥 Collected job (${detailedJobs.length}/${summaryJobs.length}): ${detailedJob.jobRole}`
            );
          } catch (detailErr) {
            console.log(
              `⚠️  Unable to enrich job "${job.title}": ${detailErr.message}`
            );
          }

          await sleep(750);
        }

        const savedJobs = await persistRoleJobs(role, detailedJobs);
        allSavedJobs.push(...savedJobs);

        await sleep(2000);
      } catch (err) {
        console.log(`❌ Error scraping ${role}: ${err.message}`);
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

  console.log("\n🏁 Scraping complete!");
  console.log(`📊 Total new jobs saved to MongoDB: ${allSavedJobs.length}`);
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
