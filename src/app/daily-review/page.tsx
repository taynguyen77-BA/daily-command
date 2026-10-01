// Daily Review now lives in My Work's "New" view (plus its Blocked / Skipped / Done views) — this
// route keeps working for bookmarks, the morning brief and saved landing pages.
import { redirect } from "next/navigation";

const DAILY_REVIEW_REDIRECT = "/my-work?view=new";

export default function DailyReviewRedirect() {
  redirect(DAILY_REVIEW_REDIRECT);
}
