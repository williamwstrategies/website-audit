const test = require('node:test');
const assert = require('node:assert/strict');
const { extractEmailsFromPage, normalizeEmail } = require('../lib/email-finder');

test('normalizes visible and mailto email addresses', () => {
  assert.equal(normalizeEmail('mailto:Info@ExampleAgency.com?subject=Hello'), 'info@exampleagency.com');
  assert.equal(normalizeEmail('hello&#64;exampleagency.com'), 'hello@exampleagency.com');
});

test('extracts the strongest public email from contact page html', () => {
  const candidates = extractEmailsFromPage({
    url: 'https://exampleagency.com/contact',
    html: `
      <a href="mailto:hello@exampleagency.com">Email us</a>
      <p>General enquiries: info@exampleagency.com</p>
      <p>Please do not use noreply@exampleagency.com.</p>
    `,
  }, 'exampleagency.com');

  assert.equal(candidates[0].email, 'hello@exampleagency.com');
  assert.equal(candidates[0].confidence, 'high');
  assert.ok(candidates.every(candidate => candidate.email !== 'noreply@exampleagency.com'));
});
