/**
 * Creates the monthly Scheduling Input form and its response sheet, for Weeklies.
 *
 * How to use (once):
 *   1. Go to https://script.google.com, signed in as the account that should own the form.
 *   2. New project. Delete what's there and paste this whole file.
 *   3. Put your faculty codes in FACULTY_CODES below. Weeklies copies them for you:
 *      Faculty input > Copy codes for the form. Code, then " - " and the name, is fine.
 *   4. Choose createForm in the function list and press Run. Allow the access it asks for.
 *   5. Open the Execution log. It prints the form link to send to faculty and the response
 *      sheet link to put in Weeklies' .env as INPUT_SHEET_ID.
 *
 * A faculty sends their whole month in one response: Item 1, then "Add another item?"
 * leads to Item 2, and so on up to ITEMS. Weeklies reads each item separately.
 *
 * Later:
 *   - New faculty: edit FACULTY_CODES and run refreshChoices.
 *   - The Month list covers this month and the next 11; run refreshChoices to move it on.
 *
 * The choices of "What is it?" must stay word for word as below, and each item's questions
 * must keep their "Item n:" start: Weeklies reads them.
 */

var FACULTY_CODES = [
  // 'AB - Faculty name',
];

var ITEMS = 6;

var KINDS = [
  'Leave (whole day)',
  'Not available for part of the day',
  'Available on my usual day off',
  'Workshop, meeting or other commitment',
  'Batch break: no classes for a batch',
  'Extra session, test or other request for a batch',
  'Centre holiday or closure',
  'Nothing to report this month',
];

function monthChoices_() {
  var names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var now = new Date();
  var list = [];
  for (var i = 0; i < 12; i++) {
    var d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    list.push(names[d.getMonth()] + ' ' + d.getFullYear());
  }
  return list;
}

/** The questions of one item. Returns its "Add another item?" question, if it has one. */
function addItem_(form, n) {
  var p = 'Item ' + n + ': ';
  // "Nothing to report" only makes sense as the first and only item.
  var kinds = n === 1 ? KINDS : KINDS.filter(function (k) { return k !== 'Nothing to report this month'; });
  form.addMultipleChoiceItem().setTitle(p + 'What is it?').setChoiceValues(kinds).setRequired(true);
  form.addDateItem().setTitle(p + 'From date').setHelpText('Needed for everything except "Nothing to report". For something without a fixed day, leave it empty and explain in Details.');
  form.addDateItem().setTitle(p + 'To date').setHelpText('Leave empty for a single day.');
  form.addTimeItem().setTitle(p + 'From time').setHelpText('Only for part of a day, such as "not available till 12 noon" (From 00:00 To 12:00), or a workshop\'s hours. Empty means the whole day.');
  form.addTimeItem().setTitle(p + 'To time');
  form.addTextItem().setTitle(p + 'Batch codes').setHelpText('For batch breaks and batch requests, such as 27CA03. Separate several with commas.');
  form.addTextItem().setTitle(p + 'Other faculty involved').setHelpText('Faculty codes of anyone else in a workshop or meeting, such as DP, AK.');
  form.addParagraphTextItem().setTitle(p + 'Details').setHelpText('What it is for, such as "Club 100 workshop", "Module 1 test", "Diwali", or the sessions needed.');
  if (n === ITEMS) return null;
  return form.addMultipleChoiceItem().setTitle(p + 'Add another item?').setRequired(true);
}

function createForm() {
  if (!FACULTY_CODES.length) throw new Error('Add your faculty codes to FACULTY_CODES first.');
  var form = FormApp.create('Scheduling Input');
  form.setDescription(
    'Send everything for the month in one response: each leave, part day, workshop, batch ' +
    'break or request is one item. After each item, choose "Yes" to add another (up to ' + ITEMS + '). ' +
    'For more, send a second response. If there is nothing for the month, choose "Nothing to ' +
    'report this month" as Item 1.\n\n' +
    'For one day, leave To date empty. Times left empty mean the whole day.'
  );
  form.setShowLinkToRespondAgain(true);
  form.setAllowResponseEdits(true);
  form.setConfirmationMessage('Thank you. You can edit your response from the link in the confirmation, until the deadline.');

  form.addListItem().setTitle('Faculty Code').setChoiceValues(FACULTY_CODES).setRequired(true);
  form.addListItem().setTitle('Month').setHelpText('The month this is for.').setChoiceValues(monthChoices_()).setRequired(true);

  var another = addItem_(form, 1);
  for (var n = 2; n <= ITEMS; n++) {
    var page = form.addPageBreakItem().setTitle('Item ' + n);
    another.setChoices([
      another.createChoice('Yes', page),
      another.createChoice('No, send it', FormApp.PageNavigationType.SUBMIT),
    ]);
    another = addItem_(form, n);
  }

  var sheet = SpreadsheetApp.create('Scheduling Input (responses)');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, sheet.getId());
  PropertiesService.getScriptProperties().setProperty('FORM_ID', form.getId());

  Logger.log('Form link for faculty: ' + form.getPublishedUrl());
  Logger.log('Edit the form: ' + form.getEditUrl());
  Logger.log('Response sheet, for INPUT_SHEET_ID in Weeklies: ' + sheet.getUrl());
}

/** Updates the Faculty Code and Month choices of the form createForm made. */
function refreshChoices() {
  var id = PropertiesService.getScriptProperties().getProperty('FORM_ID');
  if (!id) throw new Error('Run createForm first, in this same project.');
  var form = FormApp.openById(id);
  form.getItems(FormApp.ItemType.LIST).forEach(function (item) {
    var title = item.getTitle();
    if (title === 'Faculty Code' && FACULTY_CODES.length) item.asListItem().setChoiceValues(FACULTY_CODES);
    if (title === 'Month') item.asListItem().setChoiceValues(monthChoices_());
  });
  Logger.log('Updated. Form link: ' + form.getPublishedUrl());
}
