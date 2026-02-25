require('dotenv').config();

const readline = require('readline');
const { connectDB } = require('./db');
const { scrapeRoles: scrapeIndeedRoles } = require('./IndeedScraper');
const { scrapeRoles: scrapeRozeeRoles } = require('./RozeeScraper');
const { scrapeRoles: scrapeJobzRoles } = require('./JobzScraper');
const { publishSnapshots, WORDPRESS_SITES } = require('./contentPublisher');

const SCRAPER_PLATFORMS = {
    indeed: {
        label: 'Indeed.com',
        scrape: scrapeIndeedRoles
    },
    rozee: {
        label: 'Rozee.pk',
        scrape: scrapeRozeeRoles
    },
    jobz: {
        label: 'Jobz.pk',
        scrape: scrapeJobzRoles
    }
};

function createPrompt(wordpressSites = {}) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const ask = (question) =>
        new Promise((resolve) => {
            rl.question(question, resolve);
        });

    const siteEntries = Object.entries(
        Object.keys(wordpressSites).length ? wordpressSites : { primary: { key: 'primary', label: 'Primary WordPress Site' } }
    );
    const siteKeys = siteEntries.map(([key]) => key);
    const sitePrompt = [
        '\nSelect the WordPress site to publish drafts:',
        ...siteEntries.map(([key, site], index) => {
            const details = site.baseUrl ? ` - ${site.baseUrl}` : '';
            const status = site.baseUrl && site.username && site.password ? '' : ' (incomplete config)';
            return `  ${index + 1}) ${site.label || key}${details}${status}`;
        }),
        ''
    ].join('\n');

    const platformEntries = Object.entries(SCRAPER_PLATFORMS);
    const platformKeys = platformEntries.map(([key]) => key);
    const platformPrompt = [
        '\nSelect the job platform to scrape first:',
        ...platformEntries.map(([key, platform], index) => `  ${index + 1}) ${platform.label}`),
        `  ${platformEntries.length + 1}) All platforms`,
        ''
    ].join('\n');

    const parsePublishingSite = (input) => {
        const normalized = input.trim().toLowerCase();
        const numeric = parseInt(normalized, 10);
        if (!Number.isNaN(numeric) && numeric >= 1 && numeric <= siteKeys.length) {
            return siteKeys[numeric - 1];
        }

        const matchByKey = siteKeys.find((key) => key.toLowerCase() === normalized);
        if (matchByKey) {
            return matchByKey;
        }

        const matchByLabel = siteEntries.find(([, site]) => (site.label || '').toLowerCase() === normalized);
        return matchByLabel ? matchByLabel[0] : null;
    };

    const parsePlatformSelection = (input) => {
        const normalized = input.trim().toLowerCase();
        if (!normalized) {
            return null;
        }

        if (['both', 'all'].includes(normalized)) {
            return platformKeys;
        }

        const numeric = parseInt(normalized, 10);
        if (!Number.isNaN(numeric)) {
            if (numeric >= 1 && numeric <= platformKeys.length) {
                return [platformKeys[numeric - 1]];
            }
            if (numeric === platformKeys.length + 1) {
                return platformKeys;
            }
        }

        const matchByKey = platformKeys.find((key) => key === normalized);
        if (matchByKey) {
            return [matchByKey];
        }

        const matchByLabel = platformEntries.find(([, platform]) => (platform.label || '').toLowerCase() === normalized);
        if (matchByLabel) {
            return [matchByLabel[0]];
        }

        const matchByLabelVariant = platformEntries.find(([, platform]) => (platform.label || '').toLowerCase().replace(/\.pk|\.com/g, '') === normalized);
        return matchByLabelVariant ? [matchByLabelVariant[0]] : null;
    };

    return {
        async requestPublishingSite() {
            while (true) {
                const selection = await ask(`${sitePrompt}Enter choice: `);
                const parsed = parsePublishingSite(selection);
                if (parsed) {
                    return parsed;
                }
                console.log('Invalid selection. Please choose a valid WordPress site option.');
            }
        },
        async requestPlatform() {
            while (true) {
                const rawSelection = await ask(`${platformPrompt}> `);
                const parsed = parsePlatformSelection(rawSelection);
                if (parsed?.length) {
                    return parsed;
                }
                console.log('Please select one of the listed platform options.');
            }
        },
        async requestRoles() {
            let roles = [];

            while (!roles.length) {
                const rawInput = (await ask('Enter the job role to scrape (comma-separated for multiple): ')).trim();
                roles = rawInput
                    .split(',')
                    .map((role) => role.trim())
                    .filter(Boolean);

                if (!roles.length) {
                    console.log('Please enter at least one job role.');
                }
            }

            return roles;
        },
        close() {
            rl.close();
        }
    };
}

async function run() {
    console.log('Job Scraper CLI');

    // Connect to MongoDB first
    try {
        await connectDB();
    } catch (err) {
        console.error('Failed to connect to MongoDB:', err.message);
        console.error('Please check your MONGODB_URI in .env file');
        process.exit(1);
    }

    const prompt = createPrompt(WORDPRESS_SITES);

    let selectedPlatforms = [];
    let roles = [];
    let publishingSiteKey = 'primary';

    try {
        publishingSiteKey = await prompt.requestPublishingSite();
        const siteLabel = WORDPRESS_SITES[publishingSiteKey]?.label || publishingSiteKey;
        console.log(`\n📰 Selected WordPress site: ${siteLabel}`);

        roles = await prompt.requestRoles();
        selectedPlatforms = await prompt.requestPlatform();
    } finally {
        prompt.close();
    }

    const aggregatedJobs = [];

    for (const platformKey of selectedPlatforms) {
        const platform = SCRAPER_PLATFORMS[platformKey];
        if (!platform) {
            continue;
        }

        console.log(`\n🚀 Starting ${platform.label} scraper`);

        try {
            const savedJobs = await platform.scrape(roles);
            if (savedJobs.length) {
                console.log(`📦 ${savedJobs.length} new jobs saved from ${platform.label}`);
                aggregatedJobs.push(...savedJobs);
            } else {
                console.log(`⏭️  No new jobs saved from ${platform.label}`);
            }
        } catch (err) {
            console.error(`Failed to scrape ${platform.label}:`, err.message || err);
        }
    }

    if (!aggregatedJobs.length) {
        console.log('\n⏭️  No new jobs to publish (all were duplicates or already exist).');
        return;
    }

    const generatedResults = await publishSnapshots(aggregatedJobs, { siteKey: publishingSiteKey });
    if (generatedResults.length) {
        console.log('\n📝 AI-generated posts:');
        generatedResults.forEach((result) => {
            const resultSiteKey = result.wordpressSite || publishingSiteKey;
            const siteLabel = WORDPRESS_SITES[resultSiteKey]?.label || resultSiteKey;
            console.log(` - ${result.htmlPath} [${siteLabel}]`);
            if (result.wordpress?.link) {
                console.log(`   WordPress URL: ${result.wordpress.link}`);
            }
        });
    } else {
        console.log('No AI-generated documents were created.');
    }
}

run();
