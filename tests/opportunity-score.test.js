const test = require('node:test');
const assert = require('node:assert/strict');
const {
  businessQualityScore,
  calculateOpportunityScore,
  opportunityLabel,
  scorePercent,
} = require('../lib/opportunity-score');

function report({ total, conversion, seo, trust }) {
  return {
    total,
    maxScore: 100,
    categories: {
      conversion: { label: 'Conversion', score: conversion, max: 100 },
      seoVisibility: { label: 'SEO', score: seo, max: 100 },
      trustSignals: { label: 'Trust & Credibility', score: trust, max: 100 },
    },
  };
}

test('scorePercent normalizes category scores with custom maximums', () => {
  assert.equal(scorePercent(12, 15), 80);
  assert.equal(scorePercent(150, 100), 100);
  assert.equal(scorePercent(-5, 100), 0);
});

test('no-website leads are treated as high opportunity without running a scan', () => {
  const result = calculateOpportunityScore({
    hasWebsite: false,
    rating: 4.6,
    reviewCount: 72,
  });

  assert.equal(result.score, 92);
  assert.equal(result.label, 'No Website - High Opportunity');
  assert.equal(result.state, 'no_website');
  assert.ok(result.reasons.some(reason => reason.includes('No website')));
});

test('weak website with strong public proof scores as a high opportunity', () => {
  const result = calculateOpportunityScore({
    website: 'https://example.com',
    report: report({ total: 34, conversion: 28, seo: 35, trust: 42 }),
    rating: 4.8,
    reviewCount: 180,
  });

  assert.ok(result.score >= 65);
  assert.equal(result.label, 'High Opportunity');
});

test('strong website with strong public proof is not inflated into a high opportunity', () => {
  const result = calculateOpportunityScore({
    website: 'https://example.com',
    report: report({ total: 89, conversion: 86, seo: 91, trust: 84 }),
    rating: 4.8,
    reviewCount: 220,
  });

  assert.ok(result.score < 30);
  assert.equal(result.label, 'Very Low Opportunity');
});

test('missing category scores fall back to overall website need', () => {
  const result = calculateOpportunityScore({
    website: 'https://example.com',
    report: { total: 52, maxScore: 100, categories: {} },
    rating: 4.2,
    reviewCount: 45,
  });

  assert.equal(result.inputs.conversionNeed, 48);
  assert.equal(result.inputs.seoNeed, 48);
  assert.equal(result.inputs.trustNeed, 48);
});

test('business quality uses rating and review count without requiring both', () => {
  assert.ok(businessQualityScore({ rating: 4.7, reviewCount: 0 }) > businessQualityScore({ rating: 2.5, reviewCount: 0 }));
  assert.ok(businessQualityScore({ reviewCount: 150 }) > businessQualityScore({ reviewCount: 3 }));
  assert.equal(opportunityLabel(81), 'Very High Opportunity');
});
