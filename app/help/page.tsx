import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Help - Vera",
};

// Who people ping when the troubleshooting steps don't fix it.
const CONTACT = "Jorge";

// Docs are written at the behavior level on purpose ("checks the copy matches
// the copy doc"), not the rule level, so they don't go stale every time the QA
// logic is tuned. If a check's purpose changes, update it here.

type Section = { id: string; title: string; body: React.ReactNode };

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-gray-100 px-1.5 py-0.5 text-[13px] text-gray-800">{children}</code>;
}

function Badge({ tone, children }: { tone: "green" | "amber" | "red"; children: React.ReactNode }) {
  const cls =
    tone === "green"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : tone === "amber"
      ? "bg-amber-50 text-amber-700 border-amber-200"
      : "bg-red-50 text-red-700 border-red-200";
  return <span className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

function Q({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-gray-100 py-4 first:border-t-0 first:pt-0">
      <p className="text-sm font-semibold text-gray-900">{q}</p>
      <div className="mt-1.5 space-y-2 text-sm leading-relaxed text-gray-600">{children}</div>
    </div>
  );
}

const sections: Section[] = [
  {
    id: "quick-start",
    title: "Quick start",
    body: (
      <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed text-gray-600">
        <li>
          Paste the work order into <strong className="text-gray-900">Step 1</strong>. Any Google Doc, Drive folder or
          destination URL in it gets picked up automatically.
        </li>
        <li>
          In <strong className="text-gray-900">Step 2</strong>, paste the Meta <strong className="text-gray-900">Campaign ID</strong> and
          hit <strong className="text-gray-900">Load ads</strong>. Add more campaign rows if the WO covers more than one.
        </li>
        <li>Check that the ads that loaded are the ones for this promo (see the next section).</li>
        <li>
          Hit <strong className="text-gray-900">Run QA check</strong>. It takes roughly 2 to 5 minutes. Keep the tab open.
        </li>
        <li>Read the results, fix what is red, look at what is yellow, and download the PDF if you need to share it.</li>
      </ol>
    ),
  },
  {
    id: "inputs",
    title: "The inputs",
    body: (
      <div className="space-y-1">
        <Q q="Work order (Step 1)">
          <p>
            Paste the full WO: offer, creative direction, expected URLs, dates. The more of this that is in the WO, the
            more Vera can check.
          </p>
          <p>
            Google links in the WO (copy doc, creative folder) show up under &quot;Google links detected&quot;. Green
            means it was read. Red means it could not be read, and the message tells you why. See Troubleshooting.
          </p>
        </Q>
        <Q q="Campaign ID and Load ads (Step 2)">
          <p>
            Pulls every ad in the campaign straight from Meta. You do not paste preview links. One row per campaign, and
            you can add more rows.
          </p>
        </Q>
        <Q q="Filter (optional)">
          <p>
            A keyword that keeps only ads whose ad name or ad set name contains it, for example <Code>september</Code>.
            If the keyword is a month, ads whose own name carries a different month are skipped and listed by name in
            the load note, so you can see if a new ad just missed a rename.
          </p>
        </Q>
        <Q q="Only ads updated since">
          <p>
            Set this to the start of the current promo so a reused campaign does not pull in old ads from past months.
          </p>
        </Q>
        <Q q="Ad set picker and hide paused">
          <p>
            After loading, you can uncheck ad sets you do not want QA&apos;d and hide paused ads. Only the checked ads go
            into the run. Duplicated campaigns often carry last cycle&apos;s ad sets, so look at this list before running.
          </p>
        </Q>
        <Q q="Use WO copy only">
          <p>
            Ignores the copy doc and judges copy against the WO text only. Use it when the copy doc is wrong, outdated or
            not available.
          </p>
        </Q>
        <Q q="Reviewer instructions (optional)">
          <p>
            Extra context for the review, like &quot;the resort name is spelled Tahoe&quot; or &quot;the carousel cards
            intentionally link to different pages&quot;. Notes add to the QA. They do not skip checks.
          </p>
        </Q>
      </div>
    ),
  },
  {
    id: "results",
    title: "Reading the results",
    body: (
      <div className="space-y-5 text-sm leading-relaxed text-gray-600">
        <div className="space-y-2">
          <p className="font-semibold text-gray-900">Overall result</p>
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone="green">All clear</Badge> nothing was flagged.
          </p>
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone="amber">Review needed</Badge> something could not be fully verified or looks off. A human should
            look.
          </p>
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone="red">Issues found</Badge> at least one clear problem. Fix before launch.
          </p>
        </div>
        <div className="space-y-2">
          <p className="font-semibold text-gray-900">Fail vs warning</p>
          <p>
            <strong className="text-gray-900">Fail</strong> means Vera found a real mismatch it can point to, like a
            different offer, a wrong date, a misspelled word or a wrong URL.{" "}
            <strong className="text-gray-900">Warning</strong> means it could not verify something or the evidence is
            soft. Vera is built to say &quot;couldn&apos;t verify&quot; instead of guessing, so a yellow often means the
            input was missing or unreadable, not that the ad is wrong.
          </p>
        </div>
        <div className="space-y-2">
          <p className="font-semibold text-gray-900">Critical issues</p>
          <p>
            The top list groups the same problem across ads into one line with the affected ad names, so you fix it once
            instead of reading it ten times.
          </p>
        </div>
        <div className="space-y-2">
          <p className="font-semibold text-gray-900">Grouped ads</p>
          <p>
            Ads with the same copy, creative and settings are checked once and the card says it applies to all of them.
          </p>
        </div>
        <div className="space-y-2">
          <p className="font-semibold text-gray-900">Not reviewed</p>
          <p>
            If the QA call failed for some ads, an amber banner lists them with the reason. Their cards are placeholders,
            not results. Use the retry button on the banner to rerun only those ads.
          </p>
        </div>
        <div className="space-y-2">
          <p className="font-semibold text-gray-900">Download PDF</p>
          <p>Saves the results view so you can share it. Wait for the run to finish first.</p>
        </div>
      </div>
    ),
  },
  {
    id: "checks",
    title: "What each check looks at",
    body: (
      <div className="space-y-1">
        <Q q="Copy / creative alignment">
          <p>
            Two parts. Copy: the post text, headline and CTA button text against the approved copy doc (or the WO if
            there is no doc). Creative: the live image or video against the approved files in Drive, including the text
            written on the image.
          </p>
          <p>Curly vs straight quotes, dash types and line breaks are not treated as differences.</p>
          <p>
            Two extra creative checks run on their own, outside the AI review: whether the creative was actually swapped
            from last cycle&apos;s ad, and whether a carousel has the same card twice. See Troubleshooting for what those
            flags mean. When a note flags an image, it names which one (for example &quot;Carousel 1080x1080 - 2 (live
            1254×1254)&quot;) so you know exactly which card or size to fix.
          </p>
        </Q>
        <Q q="Promo month & dates">
          <p>Looks for stale or wrong months, dates and time-limited wording, judged against today&apos;s date.</p>
        </Q>
        <Q q="URL & CTA destination">
          <p>
            Compares the live click-through URL to the approved destination. Tracking parameters like utm and fbclid are
            ignored. The CTA button is checked against what the WO asked for.
          </p>
        </Q>
        <Q q="Grammar & typos">
          <p>
            Covers the ad copy and every word rendered inside the live images. A misspelling in an image is a fail even
            if the approved file has the same typo, and the note says so.
          </p>
        </Q>
        <Q q="Advantage+ AI enhancements">
          <p>
            Read straight from Meta&apos;s data for each ad. If an enhancement is on, it is flagged. If Meta does not
            report it, the card tells you to verify manually in Ads Manager.
          </p>
        </Q>
        <Q q="Format & size">
          <p>
            Checks the creative sizes and placements against what the ad is meant to be (story, feed, landscape),
            using the ad name as the main hint and the real dimensions as evidence.
          </p>
        </Q>
      </div>
    ),
  },
  {
    id: "limits",
    title: "Good to know",
    body: (
      <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-gray-600">
        <li>Nothing is saved. Each run is independent, and results disappear when you start a new check.</li>
        <li>
          Videos are compared by a single still frame on each side, and Drive and Meta pick different frames. Vera only
          flags directly conflicting text in those, so a mid-video problem can slip through. Watch the video.
        </li>
        <li>
          GIFs are read as a set of frames. Differences between frames of the same GIF are expected and not flagged.
        </li>
        <li>
          Text that is too small or blurry to read is reported as &quot;not legible&quot; (yellow), never guessed.
        </li>
        <li>
          Vera only judges what is in the WO, the docs and the approved Drive files. If the WO does not list an expected
          URL or dates, those checks have little to compare against.
        </li>
        <li>
          Open Help from the header any time. It opens in a new tab so a running check is not interrupted.
        </li>
        <li>Use your personal Commit email when reconnecting Google, not a shared or client account.</li>
      </ul>
    ),
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    body: (
      <div className="space-y-1">
        <Q q="Google link is red: authorization expired, or Google isn't connected">
          <p>
            Click <strong className="text-gray-900">Reconnect Google</strong> (header or on the red card), sign in with
            your personal Commit email, then retry the link or rerun the check.
          </p>
        </Q>
        <Q q="Google link is red: file isn't shared with the connected account">
          <p>
            The connected Google account cannot open that Doc or folder. Share it with your Commit account, or fix the
            link, and hit Retry.
          </p>
        </Q>
        <Q q="Google link is red: not found">
          <p>The link is wrong or the file was deleted. Open it in your browser to confirm, then paste the right one.</p>
        </Q>
        <Q q="Google link is red: rate limit or network">
          <p>Temporary. Wait a few seconds and hit Retry.</p>
        </Q>
        <Q q="Load ads fails with an access token message">
          <p>
            The Meta token is invalid or expired (Meta error 190). This is a server setting, not something you can fix in
            the app. Tell {CONTACT} so the token gets regenerated.
          </p>
        </Q>
        <Q q="Load ads says no ads matched">
          <p>
            The filter keyword is not in any ad name or ad set name. Try a different keyword, or clear the filter and use
            the ad set picker instead.
          </p>
        </Q>
        <Q q="Old ads from a past promo are in the list">
          <p>
            Set &quot;Only ads updated since&quot; to the promo start date, use a month keyword in Filter, and uncheck old
            ad sets in the picker. Reused campaigns keep last cycle&apos;s ads around.
          </p>
        </Q>
        <Q q="It says creative is missing or can't be found in Drive">
          <p>
            Check that the creative folder link is in the WO and is shared with the connected Google account. Vera only
            reads approved creative, so files sitting in a folder it does not treat as approved, or archived in an OLD
            folder, are skipped. If a size or card is called &quot;missing&quot;, compare against the ad in Ads Manager
            before changing anything.
          </p>
        </Q>
        <Q q="Red flag: Creative was never swapped">
          <p>
            Vera traced this ad back to the ad it was duplicated from in the previous cycle (for example the August ad
            set). Every image and video on it is the exact same file as that old ad, so the new creative was never
            uploaded. This is certain, not a guess.
          </p>
          <p>
            Fix: swap in the new approved creative in Ads Manager and rerun. The note names the old ad and ad set it
            was copied from.
          </p>
          <p>
            If it shows as yellow instead (&quot;Verify the WO wants the same creative again&quot;), Vera could only tell
            the old ad apart by date, not by name. If the WO says to rerun the same creative, you can ignore it.
          </p>
        </Q>
        <Q q="Red or yellow flag: a carousel card appears twice">
          <p>
            The live carousel shows the same card more than once, and fewer different cards than the approved folder
            has. Usually a card was swapped but the old one stayed in, or one card got uploaded twice. The note names
            which approved card is missing from the ad.
          </p>
          <p>
            Fix: open the carousel in Ads Manager, compare the cards to the approved folder, and replace the duplicate
            with the missing card. Red means the ad is short a card. Yellow means the card count adds up but something
            still looks off (a repeated card, or an approved card with no clear match), so take a look.
          </p>
        </Q>
        <Q q="A flag looks wrong (false positive)">
          <p>
            Rerun that ad once, since the review can vary slightly. If it is still wrong, add a line under Reviewer
            instructions explaining the context and rerun. If it keeps happening, send {CONTACT} the ad name, the flagged
            note and what is actually true.
          </p>
        </Q>
        <Q q="Some ads say 'not reviewed'">
          <p>
            The review call failed for those ads, usually a timeout or a temporary error. Use the retry button on the
            amber banner.
          </p>
        </Q>
        <Q q="The run seems stuck">
          <p>
            Big campaigns run in batches, and the counter shows how many batches are done. Runs take 2 to 5 minutes, and
            longer for large campaigns. If it is past 10 minutes with no batch progress, use Cancel run (your inputs are
            kept) and run again.
          </p>
        </Q>
        <Q q="It says out of credits">
          <p>The AI account behind Vera ran out of balance. Tell {CONTACT}.</p>
        </Q>
        <Q q="My inputs disappeared">
          <p>
            Inputs are kept only for the current browser tab session. Closing the tab, or clicking the Vera logo or New
            check, clears them.
          </p>
        </Q>
      </div>
    ),
  },
  {
    id: "still-stuck",
    title: "Still stuck",
    body: (
      <p className="text-sm leading-relaxed text-gray-600">
        Message {CONTACT} with the campaign ID, the ad name, what you expected, and a screenshot of what you saw.
      </p>
    ),
  },
];

export default function HelpPage() {
  return (
    <div className="min-h-screen bg-[#f8f8f6]">
      <header className="border-b border-gray-200 bg-white px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium tracking-widest text-gray-400 uppercase">Commit Agency</span>
          <span className="text-gray-200">|</span>
          <img src="/vera-wordmark-transparent.png" alt="Vera" className="h-[42px]" />
          <span className="text-gray-200">|</span>
          <span className="text-sm font-medium text-gray-700">Help</span>
        </div>
        <a
          href="/qa"
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          Home
        </a>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8 lg:grid lg:grid-cols-[200px_1fr] lg:gap-10">
        <nav aria-label="On this page" className="mb-6 lg:mb-0">
          <div className="lg:sticky lg:top-8">
            <p className="text-xs font-medium tracking-widest text-gray-400 uppercase mb-3">On this page</p>
            <ul className="space-y-1.5 text-sm">
              {sections.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`} className="text-gray-500 hover:text-gray-900 transition-colors">
                    {s.title}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </nav>

        <main className="min-w-0 space-y-5">
          <div className="mb-2">
            <h1 className="text-2xl font-semibold text-gray-900">How to use Vera</h1>
            <p className="mt-1 text-sm text-gray-500">
              Vera checks live Meta ads against the work order, the copy doc and the approved creative in Drive.
            </p>
          </div>
          {sections.map((s) => (
            <section
              key={s.id}
              id={s.id}
              className="scroll-mt-6 bg-white rounded-2xl border border-gray-200 p-6"
            >
              <h2 className="text-base font-semibold text-gray-900 mb-4">{s.title}</h2>
              {s.body}
            </section>
          ))}
          <div className="pt-2 pb-8">
            <a
              href="/qa"
              className="inline-block rounded-xl bg-gray-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-gray-800 transition-colors"
            >
              Back to Vera
            </a>
          </div>
        </main>
      </div>
    </div>
  );
}
