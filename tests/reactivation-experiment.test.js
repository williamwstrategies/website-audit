const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EXPERIMENT_KEY,
  VARIANT_DISCOUNT_MONTH,
  VARIANT_FREE_SCANS,
  VARIANTS,
  chooseNextEmailStep,
  deterministicVariantForUser,
  plannedActionForVariant,
  variantSteps,
} = require('../lib/reactivation-experiment');

test('deterministicVariantForUser assigns a stable supported variant', () => {
  const userId = '4c5f92ce-7d1c-49ef-bf6f-0c28f7bfc128';
  const first = deterministicVariantForUser(userId, EXPERIMENT_KEY);
  const second = deterministicVariantForUser(userId, EXPERIMENT_KEY);

  assert.equal(first, second);
  assert.ok(VARIANTS.includes(first));
});

test('reactivation variants have five email steps each', () => {
  assert.equal(variantSteps(VARIANT_FREE_SCANS).length, 5);
  assert.equal(variantSteps(VARIANT_DISCOUNT_MONTH).length, 5);
  assert.equal(new Set(variantSteps(VARIANT_FREE_SCANS).map(step => step.key)).size, 5);
  assert.equal(new Set(variantSteps(VARIANT_DISCOUNT_MONTH).map(step => step.key)).size, 5);
});

test('planned actions match the experiment variant', () => {
  assert.deepEqual(plannedActionForVariant(VARIANT_FREE_SCANS), {
    type: 'grant_promotional_scans',
    scans: 10,
    card_required: false,
    charged_immediately: false,
  });
  assert.deepEqual(plannedActionForVariant(VARIANT_DISCOUNT_MONTH), {
    type: 'stripe_checkout_discount',
    plan: 'professional',
    first_month_price: '$10',
    trial: false,
    charged_immediately: true,
  });
});

test('chooseNextEmailStep skips sent steps and respects assigned age', () => {
  const oldEnrollment = {
    variant: VARIANT_FREE_SCANS,
    assigned_at: new Date(Date.now() - 11 * 24 * 60 * 60 * 1000).toISOString(),
  };

  assert.equal(chooseNextEmailStep(oldEnrollment, new Set())?.key, 'free_scans_1_intro');
  assert.equal(chooseNextEmailStep(oldEnrollment, new Set(['free_scans_1_intro']))?.key, 'free_scans_2_prospect');
  assert.equal(
    chooseNextEmailStep(oldEnrollment, new Set(['free_scans_1_intro', 'free_scans_2_prospect']))?.key,
    'free_scans_3_sales_call'
  );

  const newEnrollment = {
    variant: VARIANT_DISCOUNT_MONTH,
    assigned_at: new Date().toISOString(),
  };
  assert.equal(chooseNextEmailStep(newEnrollment, new Set(['discount_1_intro'])), null);
});
