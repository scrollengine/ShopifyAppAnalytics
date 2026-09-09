/**
 * The value unions of `../constants/partnerVocab.constants`.
 *
 * Declarations only — `typeof import(…)` is erased at compile time, so importing this file costs
 * nothing at run time and does NOT pull the constants module in.
 *
 * They live here rather than beside the values because `partnerVocab.constants` ends in an export
 * assignment — which is what keeps its runtime surface a plain CommonJS object — and a module with
 * an export assignment cannot export anything else, types included (TS2309). Deriving each union
 * from `typeof` rather than restating it is what makes a new member impossible to forget: the union
 * widens automatically with the object.
 *
 *     import type { PartnerEventType } from '../types/partnerVocab.types';
 *     const _classify = (event_type: PartnerEventType) => { … };
 */

type PartnerVocabModule = typeof import('../constants/partnerVocab.constants');

/** Our internal event type, after the Partner API `__typename` has been mapped. */
export type PartnerEventType = PartnerVocabModule['PARTNER_EVENT_TYPES'][keyof PartnerVocabModule['PARTNER_EVENT_TYPES']];

/** Our internal transaction type, after the Partner API `__typename` has been mapped. */
export type PartnerTransactionType = PartnerVocabModule['PARTNER_TRANSACTION_TYPES'][keyof PartnerVocabModule['PARTNER_TRANSACTION_TYPES']];

/** Which window a partner sync pulls. `AUTO` resolves to one of the other two at dispatch. */
export type PartnerSyncMode = PartnerVocabModule['PARTNER_SYNC_MODES'][keyof PartnerVocabModule['PARTNER_SYNC_MODES']];
