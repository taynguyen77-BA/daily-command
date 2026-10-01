// My Day (Your Delivery Focus + the agenda) now lives in My Work's "Today" view — this route
// keeps working for bookmarks and saved landing pages.
import { redirect } from "next/navigation";

const FOCUS_REDIRECT = "/my-work?view=today";

export default function FocusRedirect() {
  redirect(FOCUS_REDIRECT);
}
