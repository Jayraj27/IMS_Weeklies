/*
 * A stand-in for Google's sign-in and Sheets APIs, so the sync can be tested without
 * real credentials or real student data. All people below are invented.
 */
import crypto from 'node:crypto';
import http from 'node:http';

export const HEADERS = [
  'Sr. No', 'Status', 'Comments', 'IMS ID', 'Name', 'Surname', 'Email ID', 'MOBILE NUMBER',
  'Parents / Guardian Name', 'Parents/Guardian Numbers', 'Gender', 'DOB (MM/DD/YYYY)', 'Address', 'City', 'State',
  'Pincode', 'DOJ', 'Course', 'Reference', 'Current Variant', 'Batch', 'Live batch Added?', 'University Name',
  'College Name / School Name', 'Program', 'Tution', 'Remark',
];

export function student(overrides = {}) {
  const base = {
    'Sr. No': '1', Status: 'Active', 'IMS ID': 'IMS0000000001', Name: 'Test', Surname: 'Student',
    'Email ID': 'test.student@example.com', 'MOBILE NUMBER': '9000000001', 'Parents / Guardian Name': 'Test Parent',
    'Parents/Guardian Numbers': '9000000002', Gender: 'F', 'DOB (MM/DD/YYYY)': '15-10-2005', City: 'Vadodara',
    State: 'Gujarat', Pincode: '390001', DOJ: '21/7/2024', Course: 'CAT', 'Current Variant': 'CATapult Classroom 2026',
    Batch: '26CA02', 'Live batch Added?': 'NO',
  };
  return { ...base, ...overrides };
}

/** rows: objects keyed by heading. A value may be { text, number } for a numeric cell. */
export function toGridRows(rows, headers = HEADERS) {
  const cell = (value) => {
    if (value == null || value === '') return {};
    if (typeof value === 'object') return { formattedValue: value.text, effectiveValue: { numberValue: value.number } };
    return { formattedValue: value };
  };
  return [
    { values: headers.map((h) => cell(h)) },
    ...rows.map((row) => ({ values: headers.map((h) => cell(row[h])) })),
  ];
}

export function generateServiceKey(tokenUri) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicKey,
    json: {
      type: 'service_account',
      client_email: 'weeklies-test@example.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      token_uri: tokenUri,
    },
  };
}

export async function startFakeGoogle() {
  const state = {
    tabs: { Students: [], Summary: [{ values: [{ formattedValue: 'Totals' }] }] },
    publicKey: null,
    failWith: null, // status code to return from the Sheets API
    gridRequests: [],
    badSignatures: 0,
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const [header, claims, signature] = new URLSearchParams(body).get('assertion').split('.');
      const good = crypto.verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), state.publicKey, Buffer.from(signature, 'base64url'));
      const scope = JSON.parse(Buffer.from(claims, 'base64url')).scope;
      if (!good || scope !== 'https://www.googleapis.com/auth/spreadsheets.readonly') {
        state.badSignatures += 1;
        return json(400, { error: 'invalid_grant' });
      }
      return json(200, { access_token: 'fake-token', expires_in: 3600 });
    }

    if (req.headers.authorization !== 'Bearer fake-token') return json(401, {});
    if (state.failWith) return json(state.failWith, {});
    if (req.method !== 'GET') return json(405, {});

    if (url.pathname.endsWith('/values:batchGet')) {
      const valueRanges = url.searchParams.getAll('ranges').map((range) => {
        const title = /^'(.*)'!/.exec(range)[1];
        return { values: state.tabs[title].slice(0, 10).map((r) => (r.values ?? []).map((c) => c.formattedValue ?? '')) };
      });
      return json(200, { valueRanges });
    }
    if (url.searchParams.get('includeGridData') === 'true') {
      const title = /^'(.*)'$/.exec(url.searchParams.get('ranges'))[1];
      state.gridRequests.push(title);
      return json(200, { sheets: [{ properties: { title }, data: [{ rowData: state.tabs[title] }] }] });
    }
    return json(200, { sheets: Object.keys(state.tabs).map((title) => ({ properties: { title, sheetType: 'GRID' } })) });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, state, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}
