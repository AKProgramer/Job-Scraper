require('dotenv').config();

const readline = require('readline');
const { connectDB } = require('./db');
const { scrapeRoles: scrapeIndeedRoles } = require('./IndeedScraper');
const { scrapeRoles: scrapeRozeeRoles } = require('./RozeeScraper');
const { publishSnapshots } = require('./contentPublisher');

const SCRAPER_PLATFORMS = {
    indeed: {
        label: 'Indeed.com',
        scrape: scrapeIndeedRoles
    },
    rozee: {
        label: 'Rozee.pk',
        scrape: scrapeRozeeRoles
    }
};

function createPrompt() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const ask = (question) =>
        new Promise((resolve) => {
            rl.question(question, resolve);
        });

    const platformPrompt = [
        '\nSelect the job platform to scrape first:',
        '  1) Indeed.com',
        '  2) Rozee.pk',
        '  3) Both platforms',
        ''
    ].join('\n');

    const parsePlatformSelection = (input) => {
        const normalized = input.trim().toLowerCase();
        if (['1', 'indeed', 'indeed.com'].includes(normalized)) {
            return ['indeed'];
        }
        if (['2', 'rozee', 'rozee.pk'].includes(normalized)) {
            return ['rozee'];
        }
        if (['3', 'both', 'all'].includes(normalized)) {
            return ['indeed', 'rozee'];
        }
        return null;
    };

    return {
        async requestPlatform() {
            while (true) {
                const rawSelection = await ask(`${platformPrompt}> `);
                const parsed = parsePlatformSelection(rawSelection);
                if (parsed?.length) {
                    return parsed;
                }
                console.log('Please select 1, 2, or 3 to continue.');
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

    const prompt = createPrompt();

    let selectedPlatforms = [];
    let roles = [];

    try {
        selectedPlatforms = await prompt.requestPlatform();
        roles = await prompt.requestRoles();
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

    const generatedResults = await publishSnapshots(aggregatedJobs);
    if (generatedResults.length) {
        console.log('\n📝 AI-generated posts:');
        generatedResults.forEach((result) => {
            console.log(` - ${result.htmlPath}`);
            if (result.wordpress?.link) {
                console.log(`   WordPress URL: ${result.wordpress.link}`);
            }
        });
    } else {
        console.log('No AI-generated documents were created.');
    }
}

run();
