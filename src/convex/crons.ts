import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// 07:00 UTC = 08:00 Lagos — remittance deadline reminders (PRA 2014, 7 working days).
crons.daily("pension remittance deadline reminders", { hourUTC: 7, minuteUTC: 0 }, internal.compliance.remindDeadlines, {});

export default crons;
