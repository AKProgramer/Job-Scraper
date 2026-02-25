const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { safeRoleFilename } = require("./scraperShared");

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const rawOpenAIBaseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_BASE_URL = rawOpenAIBaseUrl.replace(/\/$/, "");
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4.1-mini").trim();

const rawWordPressBaseUrl = process.env.WORDPRESS_BASE_URL || "";
const WORDPRESS_BASE_URL = rawWordPressBaseUrl.replace(/\/$/, "");
const WORDPRESS_USERNAME = (process.env.WORDPRESS_USERNAME || process.env.WORDPRESS_USER || "").trim();
const WORDPRESS_PASSWORD = (
  process.env.WORDPRESS_PASSWORD ||
  process.env.WORDPRESS_APPLICATION_PASSWORD ||
  ""
).trim();

const rawSecondWordPressBaseUrl =
  process.env.WORDPRESS_SECOND_BASE_URL ||
  process.env.WP_SECOND_BASE_URL ||
  "https://jobsmagzine.protogroup.co";
const WORDPRESS_SECOND_BASE_URL = rawSecondWordPressBaseUrl.replace(/\/$/, "");
const WORDPRESS_SECOND_USERNAME = (
  process.env.WORDPRESS_SECOND_USERNAME ||
  process.env.WP_SECOND_USERNAME ||
  "Muneed"
).trim();
const WORDPRESS_SECOND_PASSWORD = (
  process.env.WORDPRESS_SECOND_PASSWORD ||
  process.env.WP_SECOND_PASSWORD ||
  process.env.WORDPRESS_SECOND_APPLICATION_PASSWORD ||
  "1LDU xc42 goaj Sphb 1FVg yMZm"
).trim();
const WORDPRESS_PRIMARY_LABEL = (process.env.WORDPRESS_PRIMARY_LABEL || "Primary WordPress Site").trim();
const WORDPRESS_SECOND_LABEL = (process.env.WORDPRESS_SECOND_LABEL || "JobsMagzine").trim();

const DOC_OUTPUT_DIR = path.join(__dirname, "generated_posts");

function parseCategoryIds(rawValue, fallback = [242]) {
  if (!rawValue) {
    return Array.isArray(fallback) ? [...fallback] : [fallback];
  }

  const parsed = String(rawValue)
    .split(",")
    .map((segment) => parseInt(segment.trim(), 10))
    .filter((id) => !Number.isNaN(id) && id > 0);

  if (parsed.length) {
    return parsed;
  }

  return Array.isArray(fallback) ? [...fallback] : [fallback];
}

const PRIMARY_CATEGORY_IDS = parseCategoryIds(process.env.WORDPRESS_CATEGORY_IDS, [242]);
const SECONDARY_CATEGORY_IDS = parseCategoryIds(
  process.env.WORDPRESS_SECOND_CATEGORY_IDS || process.env.WP_SECOND_CATEGORY_IDS,
  PRIMARY_CATEGORY_IDS
);

const WORDPRESS_SITES = {
  primary: {
    key: "primary",
    label: WORDPRESS_PRIMARY_LABEL,
    baseUrl: WORDPRESS_BASE_URL,
    username: WORDPRESS_USERNAME,
    password: WORDPRESS_PASSWORD,
    categories: PRIMARY_CATEGORY_IDS
  },
  secondary: {
    key: "secondary",
    label: WORDPRESS_SECOND_LABEL,
    baseUrl: WORDPRESS_SECOND_BASE_URL,
    username: WORDPRESS_SECOND_USERNAME,
    password: WORDPRESS_SECOND_PASSWORD,
    categories: SECONDARY_CATEGORY_IDS
  }
};

const PROMPT_TEMPLATE = `
You are a professional job content writer and editor.

Your task:
Rewrite and professionally rephrase the provided job data into an ORIGINAL, human-written job post.
The final content must NOT copy wording, sentence structure, or phrasing from Indeed or any source.
All text must be written in your own natural, professional wording while preserving the original meaning.

CRITICAL CONTENT RULES (must follow strictly):
- DO NOT copy sentences verbatim from the source.
- DO NOT closely mirror sentence structure or phrasing.
- Rewrite everything in clear, natural, human-like language.
- Ensure the content reads as manually written by a professional recruiter.
- Avoid repetitive, robotic, or AI-detectable phrasing.
- Maintain factual accuracy — do NOT invent details.

STRUCTURE & OUTPUT RULES:
- Focus ONLY on the job post content.
- Do NOT include website header, footer, sidebar, search, comments, or related posts.
- Output ONLY a single <article> element.
- Use ONLY the headings that exist in the Job Format PDF.
- If a heading cannot be populated from the JSON, OMIT the heading AND its divider completely.
- Do NOT add sections like “About the Company” unless explicitly present in job data.
- Use <div class="divider">Shape</div> ONLY between valid sections.

ALLOWED SECTION ORDER (do not change):

1. <h1>Job Title – Company (Location)</h1>

2. Metadata block using <p> tags with <strong> labels (include only if data exists):
   - Company
   - Location
   - Salary
   - Job Type
   - Industry
   - Experience Required
   - Work Model

3. Divider

4. <h2>About the Role</h2>
   - Write a concise, engaging summary in ORIGINAL wording.
   - Do not reuse source phrasing.

5. Divider

6. <h2>Key Responsibilities</h2>
   - Rewrite responsibilities using fresh sentence structure.
   - Use bullet points.
   - Use <h3> subheadings ONLY if responsibilities are clearly grouped.

7. Divider

8. <h2>Required Skills</h2>
   - List skills using rewritten, natural language.

9. Divider

10. <h2>Qualifications</h2>
    - Rephrase education and experience requirements clearly.

11. Divider

12. <h2>Key Traits</h2>
    - ONLY include if traits are explicitly mentioned in the job data.

13. Divider

14. <h2>Why Join [Company Name]</h2>
    - Rewrite benefits and reasons in an appealing, original tone.

15. Divider

16. <h2>How to Apply</h2>
    - Include apply link exactly as:
      <a href="URL" target="_blank" rel="noopener">Apply Now</a>

17. Divider

18. <h2>SEO Meta Details</h2>
    - <p><strong>Meta Title:</strong> Write an original SEO-friendly title</p>
    - <p><strong>Meta Description:</strong> Write a natural, human-sounding meta description</p>

STYLE RULES:
- Professional, recruiter-style tone
- Short, clear paragraphs
- Bullet points where appropriate
- No filler phrases
- No placeholders like “Not provided”
- Avoid generic AI phrases (e.g., “We are seeking a dynamic individual”)
- Escape HTML properly

IMPORTANT:
Your goal is originality, clarity, and professionalism — NOT duplication.

Return ONLY valid HTML.

JSON INPUT:
{{INSERT_JSON_HERE}}
`;

function getWordPressSiteConfig(siteKey = "primary") {
  return WORDPRESS_SITES[siteKey] || WORDPRESS_SITES.primary || null;
}

function ensureEnvOrWarn(siteConfig) {
  if (!siteConfig) {
    console.log("Skipping AI content generation and WordPress publishing because no WordPress site configuration was provided.");
    return false;
  }

  const missing = [];
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!siteConfig.baseUrl) missing.push(`${siteConfig.label || siteConfig.key}: WORDPRESS_BASE_URL`);
  if (!siteConfig.username) missing.push(`${siteConfig.label || siteConfig.key}: WORDPRESS_USERNAME`);
  if (!siteConfig.password) missing.push(`${siteConfig.label || siteConfig.key}: WORDPRESS_PASSWORD or WORDPRESS_APPLICATION_PASSWORD`);

  if (missing.length) {
    console.log(
      `Skipping AI content generation and WordPress publishing for "${siteConfig.label || siteConfig.key}" because these environment variables are missing: ${missing.join(", ")}`
    );
    return false;
  }

  return true;
}

async function callOpenAI(jobPayload) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const prompt = PROMPT_TEMPLATE.replace(
    "{{INSERT_JSON_HERE}}",
    JSON.stringify(jobPayload, null, 2)
  );

  try {
    const response = await axios.post(
      `${OPENAI_BASE_URL}/chat/completions`,
      {
        model: OPENAI_MODEL,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.7
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 60000
      }
    );

    const choice = response.data?.choices?.[0]?.message?.content;
    if (!choice) {
      throw new Error("No content returned from OpenAI");
    }

    return choice.trim();
  } catch (err) {
    const status = err.response?.status;
    const detailMessage = err.response?.data?.error?.message || err.message;
    const enhancedMessage = status
      ? `OpenAI request failed (${status}): ${detailMessage}`
      : `OpenAI request failed: ${detailMessage}`;
    throw new Error(enhancedMessage);
  }
}

function deriveTitle(job, role) {
  return (
    job.jobRole ||
    job.title ||
    job.jobTitle ||
    (role ? `${role} Opportunity` : "Job Opportunity")
  );
}

function ensureDocOutputDir() {
  if (!fs.existsSync(DOC_OUTPUT_DIR)) {
    fs.mkdirSync(DOC_OUTPUT_DIR, { recursive: true });
  }
}

function toFilenameSegment(value) {
  if (!value) {
    return "";
  }
  const safeValue = safeRoleFilename(String(value));
  return safeValue.replace(/\s+/g, "-").toLowerCase();
}

function buildDocFilename(role, job, index, title) {
  const segments = [];
  const roleSegment = toFilenameSegment(role) || "role";
  segments.push(roleSegment);

  const jobIdSegment = toFilenameSegment(job.jobId);
  if (jobIdSegment) {
    segments.push(jobIdSegment);
  }

  const titleSegment = toFilenameSegment(title);
  if (titleSegment) {
    segments.push(titleSegment);
  }

  segments.push(String(Date.now()));

  if (!jobIdSegment && !titleSegment) {
    segments.push(`job${index + 1}`);
  }

  return `${segments.filter(Boolean).join("-")}.html`;
}

const PLACEHOLDER_PATTERNS = [
  /information not provided/i,
  /information not available/i,
  /details not provided/i,
  /details not available/i,
  /^not provided$/i,
  /^not available$/i,
  /^n\/?a$/i
];

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrapHtmlDocument(title, bodyHtml) {
  const safeTitle = escapeHtml(title || "Job Opportunity");
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <title>${safeTitle}</title>\n</head>\n<body>\n${bodyHtml}\n</body>\n</html>`;
}

function cleanArticleHtml(articleHtml) {
  let cleanedHtml = articleHtml;

  cleanedHtml = cleanedHtml.replace(
    /<h2\b[^>]*>[\s\S]*?(?=<h2\b|<div class="divider">Shape<\/div>|<\/article>)/gi,
    (section) => {
      const headingMatch = section.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
      const headingText = headingMatch
        ? headingMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
        : "";
      const contentHtml = section.replace(/^[\s\S]*?<\/h2>/i, "");
      const contentText = contentHtml
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (!contentText) {
        return "";
      }

      const hasPlaceholder = PLACEHOLDER_PATTERNS.some((pattern) =>
        pattern.test(contentText)
      );

      if (hasPlaceholder) {
        return "";
      }

      return section;
    }
  );

  cleanedHtml = cleanedHtml.replace(
    /<div class="divider">Shape<\/div>\s*(?=(<div class="divider">Shape<\/div>|<\/article>))/gi,
    ""
  );

  cleanedHtml = cleanedHtml.replace(
    /<div class="divider">Shape<\/div>\s*(?=<h2\b[^>]*>)/gi,
    (divider, offset) => {
      const remaining = cleanedHtml.slice(offset + divider.length);
      const nextSection = remaining.match(/^(\s*<h2\b[^>]*>[\s\S]*?<\/h2>)/i);
      if (!nextSection) {
        return "";
      }
      const nextHeading = nextSection[0]
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!nextHeading) {
        return "";
      }
      return divider;
    }
  );

  return cleanedHtml;
}

function stripHtmlTags(html) {
  return html.replace(/<[^>]+>/g, " ");
}

function buildExcerptFromHtml(html) {
  const plain = stripHtmlTags(html).replace(/\s+/g, " ").trim();
  if (!plain) {
    return "";
  }
  return plain.slice(0, 280);
}

async function publishToWordPress({ title, content, excerpt }, siteConfig) {
  if (!siteConfig?.baseUrl) {
    throw new Error("WordPress base URL is not configured");
  }

  const endpoint = `${siteConfig.baseUrl}/wp-json/wp/v2/posts`;
  const authHeader = Buffer.from(`${siteConfig.username}:${siteConfig.password}`).toString("base64");
  const categories =
    Array.isArray(siteConfig.categories) && siteConfig.categories.length ? siteConfig.categories : [242];

  const payload = {
    title,
    status: "draft",
    content,
    excerpt,
    categories
  };

  const response = await axios.post(endpoint, payload, {
    headers: {
      Authorization: `Basic ${authHeader}`,
      "Content-Type": "application/json"
    },
    timeout: 30000
  });

  let parsed = response.data;

  if (typeof parsed === "string" && parsed.trim()) {
    try {
      parsed = JSON.parse(parsed);
    } catch (parseErr) {
      const preview = parsed.length > 200 ? `${parsed.slice(0, 200)}…` : parsed;
      throw new Error(`Unexpected WordPress response format (text): ${preview}`);
    }
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("WordPress API returned an empty response");
  }

  if (parsed.success === false) {
    const extra = parsed.data && typeof parsed.data === "object" ? JSON.stringify(parsed.data) : parsed.data || "";
    const message = parsed.message || "WordPress API rejected the request";
    throw new Error(extra ? `${message}: ${extra}` : message);
  }

  const candidateId = parsed.id ?? parsed.post_id ?? parsed?.data?.id ?? parsed?.data?.post_id;
  let candidateLink =
    parsed.link ??
    parsed?.guid?.rendered ??
    parsed?.data?.link ??
    parsed?.data?.permalink ??
    response.headers?.location;

  if (typeof candidateLink === "string" && /^<.*>$/.test(candidateLink)) {
    candidateLink = candidateLink.slice(1, -1);
  }

  if (!candidateId && !candidateLink) {
    const serialized = JSON.stringify(parsed, null, 2);
    const preview = serialized.length > 400 ? `${serialized.slice(0, 400)}…` : serialized;
    throw new Error(`WordPress API response missing post identifier: ${preview}`);
  }

  const normalized = { ...parsed };
  if (candidateId && normalized.id == null) {
    normalized.id = candidateId;
  }
  if (candidateLink && normalized.link == null) {
    normalized.link = candidateLink;
  }

  return normalized;
}

async function processJob(job, role, index, siteConfig) {
  const aiPayload = {
    role,
    job
  };

  let articleHtml = await callOpenAI(aiPayload);
  if (!/^<article[\s>]/i.test(articleHtml.trim())) {
    articleHtml = `<article>\n${articleHtml.trim()}\n</article>`;
  }
  articleHtml = cleanArticleHtml(articleHtml);
  const title = deriveTitle(job, role);

  ensureDocOutputDir();
  const docFilename = buildDocFilename(role, job, index, title);
  const docPath = path.join(DOC_OUTPUT_DIR, docFilename);

  const wrappedHtml = wrapHtmlDocument(title, articleHtml);
  fs.writeFileSync(docPath, wrappedHtml, "utf8");

  const excerpt = buildExcerptFromHtml(articleHtml);

  let wordpressResult = null;
  const siteLabel = siteConfig?.label || siteConfig?.key || "WordPress";
  try {
    wordpressResult = await publishToWordPress(
      {
        title,
        content: articleHtml,
        excerpt
      },
      siteConfig
    );
    console.log(
      `🚀 Published WordPress post (${siteLabel}): ${wordpressResult.link || wordpressResult.id}`
    );
  } catch (wpErr) {
    console.error(
      `Failed to publish WordPress post for role ${role} on ${siteLabel}:`,
      wpErr.message
    );
  }

  console.log(`📝 Saved job post: ${docPath}`);
  return {
    role,
    title,
    htmlPath: docPath,
    wordpress: wordpressResult,
    wordpressSite: siteConfig?.key || "primary"
  };
}

async function publishSnapshots(jobDocuments, options = {}) {
  if (!jobDocuments.length) {
    console.log("No jobs to publish.");
    return [];
  }

  const siteKey = options.siteKey || "primary";
  const siteConfig = getWordPressSiteConfig(siteKey);

  if (!ensureEnvOrWarn(siteConfig)) {
    return [];
  }

  const Job = require('./models/Job');
  const generatedOutputs = [];

  console.log(
    `Publishing drafts to ${siteConfig?.label || siteConfig?.key} (${siteConfig?.baseUrl || "not configured"})`
  );

  for (const [jobIndex, jobDoc] of jobDocuments.entries()) {
    try {
      // Double-check if already published (defensive programming)
      if (jobDoc.publishedToWordPress) {
        console.log(`⏭️  Already published to WordPress: ${jobDoc.jobRole} (jobId: ${jobDoc.jobId})`);
        continue;
      }

      // Refresh from database to ensure we have latest state
      const latestJob = await Job.findOne({ jobId: jobDoc.jobId });

      if (!latestJob) {
        console.log(`⚠️  Job not found in database: ${jobDoc.jobId}`);
        continue;
      }

      if (latestJob.publishedToWordPress) {
        console.log(`⏭️  Already published (checked DB): ${latestJob.jobRole} (jobId: ${latestJob.jobId})`);
        continue;
      }

      const role = latestJob.searchRole;
      const result = await processJob(latestJob.toObject(), role, jobIndex, siteConfig);

      // Update job document with WordPress publishing info
      if (result.wordpress) {
        await Job.updateOne(
          { jobId: latestJob.jobId },
          {
            $set: {
              publishedToWordPress: true,
              wordPressPostId: result.wordpress.id,
              wordPressPostUrl: result.wordpress.link,
              publishedAt: new Date()
            }
          }
        );
        console.log(`✅ Marked as published in MongoDB: ${latestJob.jobId}`);
      }

      generatedOutputs.push(result);
    } catch (jobErr) {
      console.error(`Failed to generate post for job ${jobDoc.jobId}:`, jobErr.message);
    }
  }

  if (generatedOutputs.length) {
    console.log("Generated documents:");
    generatedOutputs.forEach(({ htmlPath, wordpressSite }) =>
      console.log(` - ${htmlPath} [${wordpressSite || siteKey}]`)
    );
  }

  return generatedOutputs;
}

module.exports = {
  publishSnapshots,
  WORDPRESS_SITES
};
