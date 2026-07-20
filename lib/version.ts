/**
 * App version = the running count of shipped changes ("poprawek").
 *
 * BUMP THIS BY 1 on every commit that changes app behavior, and mention the
 * new number when reporting the fix. The number is rendered in the UI (small,
 * bottom-right corner) so the user can confirm at a glance which build is
 * actually live on the deployed site before spending image-generation
 * credits on it — if the footer still shows the old number, the new deploy
 * hasn't propagated yet.
 *
 * History: started at 19 on 2026-07-11 (= 18 prior commits + this feature).
 */
export const APP_VERSION = 27;
