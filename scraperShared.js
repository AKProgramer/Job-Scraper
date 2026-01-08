const Job = require('./models/Job');

function safeRoleFilename(role) {
  if (!role) return 'role';
  return (
    role
      .replace(/[<>:"/\\|?*]+/g, '')
      .replace(/\s+/g, ' ')
      .trim() || 'role'
  );
}

function extractJobId(link) {
  try {
    const url = new URL(link);
    return (
      url.searchParams.get('vjk') ||
      url.searchParams.get('jk') ||
      url.pathname.split('/').filter(Boolean).pop()
    );
  } catch (err) {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function persistRoleJobs(role, jobs) {
  const savedJobs = [];
  const skippedJobs = [];

  for (const job of jobs) {
    if (!job.jobId) {
      console.log(`⚠️  Skipping job without jobId: ${job.jobRole || 'Unknown'}`);
      continue;
    }

    try {
      const existingJob = await Job.findOne({ jobId: job.jobId });

      if (existingJob) {
        console.log(`⏭️  Duplicate found, skipping: ${job.jobRole} (jobId: ${job.jobId})`);
        skippedJobs.push(job.jobId);
        continue;
      }

      const newJob = new Job(job);
      await newJob.save();
      savedJobs.push(newJob);
      console.log(`💾 Saved to MongoDB: ${job.jobRole} (jobId: ${job.jobId})`);
    } catch (error) {
      if (error.code === 11000) {
        console.log(`⏭️  Duplicate detected (race condition): ${job.jobRole} (jobId: ${job.jobId})`);
        skippedJobs.push(job.jobId);
      } else {
        console.error(`❌ Error saving job ${job.jobId}:`, error.message);
      }
    }
  }

  console.log(`\n📊 Summary for role "${role}":`);
  console.log(`   ✅ Saved: ${savedJobs.length} new jobs`);
  console.log(`   ⏭️  Skipped: ${skippedJobs.length} duplicates`);

  return savedJobs;
}

module.exports = {
  safeRoleFilename,
  extractJobId,
  persistRoleJobs,
  sleep
};
