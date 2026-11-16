# Weeklies

Admin console for an institute's faculties, courses, batches, master flows and rooms.

## Run it

Needs Node.js 22.13 or newer.

```
npm install
npm start
```

Then open http://localhost:3000/admin/

Data is stored in `data/weeklies.db`. Back up that file to back up everything.

The first start creates an admin and prints its password once in the terminal. To add an
admin or reset a forgotten password, run `npm run set-password -- <username>`.

Settings, as environment variables: `PORT`, `HOST`, `DB_PATH`.

## Put it online

The app stores its data in one SQLite file, so it needs a host with a permanent disk and
must run as a single copy. Serverless hosts such as Vercel lose that file. `Dockerfile`
and `render.yaml` are ready for Render:

1. Put this project in a **private** GitHub repository. `.gitignore` keeps `.env`, `data/`
   and `secrets/` out of it.
2. In Render, choose New > Blueprint and select the repository.
3. Enter the secret settings when asked:
   - `ADMIN_USERNAME` and `ADMIN_PASSWORD` (at least 10 characters). The app won't start
     without a password. They're used only to create the first admin.
   - `GOOGLE_SERVICE_ACCOUNT_JSON`: the whole contents of the key file.
4. Open the address Render gives you and sign in. Then change the password under Change
   password, and delete `ADMIN_PASSWORD` from Render's settings.

Data on your computer doesn't move across on its own; the online app starts empty.
Check that the host keeps backups of the disk, and try restoring one.

If the student sheet can't be shared outside imsindia.com, its Google admin has to allow it.

## Connect the student sheet

Students come from the BRD student sheet, which stays the source of truth. The app
signs in with its own read-only Google identity (a service account), and never writes
to the sheet.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and
   enable the **Google Sheets API** (APIs & Services > Library).
2. Go to APIs & Services > Credentials, create a **service account**, then open it and
   under Keys choose Add key > Create new key > **JSON**. No project roles are needed.
3. Save the downloaded file as `secrets/google-service-account.json` in this project.
4. Ask the sheet's owner or an editor to **share the sheet as Viewer** with the service
   account's email (the `client_email` value in that file, ending in
   `.iam.gserviceaccount.com`). If sharing outside imsindia.com is blocked, the
   organisation's Google admin has to allow it.
5. Restart with `npm start`.

Settings are in `.env`: the sheet, the key file, the tab and the sync interval.

The key file gives access to student records, so don't email it or commit it. If it
leaks, delete that key in Google Cloud and create a new one.

### How the sync behaves

- It runs when the app starts, then every 5 minutes. Students > Sync now runs it on demand.
- Each good read replaces the local copy in `data/weeklies.db`. Edits belong in the sheet.
- The old copy is kept if a read fails, the sheet comes back empty, a required column
  (IMS ID, Name, Status, Course, Batch) is missing, or the list suddenly shrinks by more
  than half. That last case can be confirmed on the Students page. Failures show on the
  Students and Overview pages.
- Columns are found by heading, so moving them is safe. New columns are kept in each
  student's full record.
- Doubtful values, such as a repeated IMS ID or a date of birth that could be day/month
  or month/day, are flagged under "Needs checking" and never corrected.

## How the pieces fit

- **Courses** define the faculty slots (Mentor, QA1, VRC1...) that new batches start with.
- **Faculties** are identified by Faculty Code, with courses, subjects, topics and
  week-offs. Upload a list with Faculties > Upload faculty. A known code updates that
  faculty, and a column left out stays unchanged.
- **Batch faculty:** each slot has one primary faculty and substitutes in order of
  preference. Upload with Batches > Upload batch faculty: Batch, Slot, Faculty Code,
  Substitutes, one row per batch and slot.
- **Batch timetable:** weekdays and hours, which can differ by day, plus start and end
  dates. Upload with Batches > Upload timetable: Batch, Weekdays, Start Time, End Time,
  Start Date, End Date, one row per set of hours. Times without AM or PM before 7:00 are
  refused rather than guessed, and dates are read day first.
- **Weekly schedule:** Generate week fills each batch's classes with the next unfinished
  sessions of its master flow. Each class gets the faculty in that subject's slot, or a
  substitute if they're on week-off or already teaching, and the smallest free room that
  seats the batch's active students. Batches marked online go in the shared Online column.
  The day grid shows rooms across and times down: drag a block to move it, click it to
  edit, and double-click empty space or use Add block for meetings. Room and faculty
  clashes, week-offs and rooms that are too small are flagged on the block. Marking a class
  done records its session in Batch progress. Subjects must be named the same in the flow
  and the slots: QA matches QA, but VA doesn't match VARC.
- **Students' courses** come from the sheet's Current Variant. Each variant is ticked into
  one course, either in that course's Edit dialog or from the list under Courses > Current
  Variants. Nothing is assigned by itself, so a new variant in the sheet waits, and is
  listed on the Overview, until someone chooses its course.
- **Batches** come from the sheet's Batch column: each code with an Active student becomes
  a batch in the course most of its active students belong to, and copies that course's
  slots, which can then vary per batch. Codes that differ only in spacing or capitals are
  the same batch. A batch is never removed automatically, and one that has faculty
  assigned or is in a group flow never changes course by itself. A slot can stay unfilled
  for now, and the Overview page lists what's still open.
- **Planned batches** can be added by hand before any student has that code. They link up
  when the code appears in the sheet.
- **Master flows** belong to a course, one per variant of it (such as CAT 27 or Crash
  CAT 26). Upload one by pasting rows or choosing a CSV. Columns are found by heading:
  Topic and Subject are needed; Topic Code, Area and Homework link are optional. Tick the
  batches that follow it. Each batch follows one flow. A course-wide flow is also
  possible, covering every batch not mapped to its own flow.
- **Batch progress** records which sessions each batch has finished. Set the last finished
  session per subject, because subjects move at different speeds, or use "All up to No"
  when a batch has followed the order exactly. Re-uploading a corrected flow keeps progress:
  rows are matched by code and topic, or by code alone when a topic has been corrected.

## Tests

`npm test` runs the API tests against a temporary database.
