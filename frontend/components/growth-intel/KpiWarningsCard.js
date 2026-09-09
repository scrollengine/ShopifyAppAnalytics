import { BlockStack, Text } from '@shopify/polaris';

import { cardShell } from './cardShell';

/**
 * =============================================================================
 *  "Worth knowing about these figures" — the server's own caveats, in one place.
 * =============================================================================
 *
 *   THE CAVEATS ARE NOT DECORATION. They are the half of the KPI payload that
 *  changes how a figure READS: that estimated active is a fold over the
 *  relationship event stream rather than a count Shopify publishes, that this
 *  window's payouts span two currencies and nothing in this build converts
 *  between them, that N events carry no shop domain and are therefore counted in
 *  the install tile but attributed to no store. A tile without them is not wrong;
 *  it is overconfident, which on this project is the same failure.
 *
 *  ── WHY A COMPONENT AND NOT SIX LINES ON EACH PAGE ──────────────────────────
 *  Two screens now render the same KPI payload — the Overview (`/overview`)
 *  and the Partner Apps setup screen (`/apps`) — and the rendering
 *  carries two rules that are invisible in the markup:
 *
 *    1. KEYED BY THE SENTENCE ITSELF. `partnerAppKpi.service.ts` collects
 *       warnings through a Set for exactly this reason, and says so: a duplicate
 *       is not drawn twice, it is DROPPED, and the condition that raised it goes
 *       with it. Keying by index would hide that; keying by the string makes the
 *       service's guarantee the thing the UI depends on.
 *    2. AN EMPTY LIST IS NOT A CARD. No warnings means the service raised none
 *       for this window. An empty "Worth knowing about these figures" card reads
 *       as a caveat that failed to load rather than as an absence of caveats, so
 *       the whole card is omitted instead.
 *
 *  Two copies of those rules is two chances for one of them to grow a `|| []`,
 *  sort the list, or key by index — and the copy that drifts is the one nobody
 *  is looking at.
 *
 *  ⚠️ ONLY EVER RENDER THIS BESIDE FIGURES THAT EXIST. The warnings come off a
 *  READY payload and describe THOSE numbers; hoisted above a `<DataStateSection>`
 *  they would survive into the states where the numbers do not, and a caveat with
 *  no figure to qualify reads as a fault in the deployment.
 * =============================================================================
 */

/**
 * The warnings that can be rendered honestly: non-empty strings, in the order the service sent them.
 *
 * ⚠️ A NON-STRING IS DROPPED RATHER THAN PRINTED. Every warning on this payload is a plain sentence
 * composed by the service, so any other shape is a contract change — and `[object Object]` under a
 * heading promising something worth knowing reads as a rendering bug rather than as a missing
 * caveat. It is also unkeyable: React would need an index, and an index key over a list that can be
 * filtered is how one sentence ends up attached to another row.
 *
 * NOT SORTED AND NOT DEDUPED. The service emits them in the order it decided them and guarantees
 * they are unique; doing either again here would paper over a contract change instead of surfacing
 * it as the missing sentence it is.
 *
 * @param {Array|null} warnings - The `warnings` array from a KPI payload, or anything at all.
 * @returns {Array<String>} Renderable sentences, possibly empty.
 */
const _renderable = (warnings) => {
    if (!Array.isArray(warnings)) {
        return [];
    }
    return warnings.filter((warning) => typeof warning === 'string' && warning.trim().length > 0);
};

/**
 * Renders the KPI payload's caveats, or nothing at all when it carries none.
 *
 * @param {Object} props
 * @param {Array|null} props.warnings - `kpi.warnings` from a READY payload. Null, undefined or an
 *   empty array all render NOTHING — see rule 2 in the header.
 * @param {String} [props.title] - Heading. The default is the sentence the Partner Apps page has
 *   used since these caveats first shipped; override it only to say something MORE specific.
 * @param {Boolean} [props.bare=false] - Forwarded to `cardShell` when the caller supplies the Card.
 * @param {String} [props.cardPadding] - Forwarded to `cardShell`.
 * @returns {JSX.Element|null}
 */
const KpiWarningsCard = ({ warnings, title = 'Worth knowing about these figures', bare = false, cardPadding }) => {
    const items = _renderable(warnings);

    if (items.length === 0) {
        return null;
    }

    const wrap = cardShell(bare, { cardPadding });

    return wrap(
        <BlockStack gap="150">
            <Text as="h3" variant="headingSm">{title}</Text>
            {/* Keyed by the STRING — see rule 1. */}
            {items.map((warning) => (
                <Text key={warning} as="p" variant="bodySm" tone="subdued">{warning}</Text>
            ))}
        </BlockStack>
    );
};

export default KpiWarningsCard;
