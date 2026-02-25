const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
    // Unique identifier from Indeed
    jobId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },

    // Search and role information
    searchRole: {
        type: String,
        required: true
    },
    searchLocation: String,
    jobRole: {
        type: String,
        required: true
    },

    // Company information
    companyName: String,
    companyProfileUrl: String,

    // Application URLs
    applyNowUrl: String,
    externalApplyUrl: String,
    detailUrl: String,

    // Location and compensation
    location: String,
    salary: String,
    postedAt: String,

    // Job details
    jobDetails: {
        jobType: String,
        shiftAndSchedule: String,
        workSetting: String,
        workplaceType: String,
        compensationDetails: String,
        contractType: String,
        securityClearance: String,
        travelRequirement: String,
        jobIndustry: String,
        functionalArea: String,
        totalPositions: String,
        gender: String,
        careerLevel: String,
        applyBefore: String,
        postingDate: String
    },

    // Job description and requirements
    jobDescription: String,
    benefits: [String],
    experience: String,
    education: String,

    // WordPress publishing tracking
    publishedToWordPress: {
        type: Boolean,
        default: false
    },
    wordPressPostId: Number,
    wordPressPostUrl: String,
    publishedAt: Date,

    // Metadata
    scrapedAt: {
        type: Date,
        default: Date.now
    },
    error: String
}, {
    timestamps: true
});

// Create index on jobId for fast duplicate checking
jobSchema.index({ jobId: 1 }, { unique: true });

// Create index on publishedToWordPress for filtering
jobSchema.index({ publishedToWordPress: 1 });

const Job = mongoose.model('Job', jobSchema);

module.exports = Job;
