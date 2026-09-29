import { Card, BlockStack, InlineStack, Text, Badge, Button, Divider, Box } from '@shopify/polaris';
import { useCallback, useMemo } from 'react';
import ManualSyncButton from './ManualSyncButton';
import { SYNC_SCOPES } from './syncCategories';

const _fmtWhen = (iso) => {
    if (!iso) return null;
    try { return new Date(iso).toLocaleString(); } catch (e) { return String(iso); }
};

/**
 * One background-job category: what it pulls, when it runs itself, when it last succeeded, and the
 * buttons to force it.
 *
 * ── FOUR REASONS A BUTTON MAY BE OFF, AND THEY ARE NOT THE SAME ───────────
 *   1. NO APP SELECTED  — an APP-scoped job has no target. Says so.
 *   2. `disabled`       — the caller knows this job CANNOT succeed right now (its data source is
 *                         not configured). `disabledReason` is then MANDATORY: a dead button with
 *                         no explanation is worse than one that fails, because a failure at least
 *                         carries a message.
 *   3. `permissionReason` — the signed-in role does not include the permission that starts this
 *                         job (`sync:run`, or `sync:run_billed` for a BigQuery scan). Separate from
 *                         (2) because the remedy is different — (2) is fixed in the API's
 *                         environment, this one only by an Owner or Admin changing the role — and
 *                         both can hold at once. A non-empty string both blocks and explains, so the
 *                         reason cannot be forgotten.
 *   4. Already running  — owned by `ManualSyncButton` itself, which goes into its loading state on
 *                         click and stays there until the job reaches a terminal status.
 *
 * ── ⚠️ "NEVER COMPLETED SUCCESSFULLY" IS A CLAIM, NOT A DEFAULT ──────────────
 * A card with no `lastSuccess` renders that sentence, which is fine when the caller genuinely
 * knows. When the caller has NO WAY to know — no endpoint reports that watermark — it must pass
 * `lastSuccessUnknownReason` instead, and the card renders `—` with the reason. Reporting a
 * confident negative built from a gap in our own reading is the failure this project exists to
 * refuse.
 *
 * @param {Object}   props
 * @param {Object}   props.category    - a SYNC_CATEGORIES entry.
 * @param {Object}   [props.lastSuccess] - `{ completed_at }` for the most recent successful run.
 * @param {String}   [props.lastSuccessLabel] - How that timestamp is scoped, in the reader's words.
 *   Defaults to the cross-app phrasing of GET /sync/health; pass an app-scoped label when the value
 *   came from the app row instead.
 * @param {String}   [props.lastSuccessUnknownReason] - Shown in place of "Never completed
 *   successfully" when there is no timestamp AND none can be read.
 * @param {String}   props.appId       - selected partner app; '' when none.
 * @param {Boolean}  [props.disabled]  - Blocks every action in this card.
 * @param {String}   [props.disabledReason] - Why. Required whenever `disabled` is true.
 * @param {String}   [props.permissionReason] - Non-empty when the role cannot start this job; the
 *   sentence saying so. Blocks every action in this card, the inline estimate included.
 * @param {Function} props.showToast
 * @param {Function} props.onFinish    - called after any triggered job reaches a terminal status.
 * @param {Function} props.onNavigate  - router push, for the entity-scoped categories.
 */
const SyncCategoryCard = ({
    category,
    lastSuccess,
    lastSuccessLabel,
    lastSuccessUnknownReason,
    appId,
    disabled,
    disabledReason,
    permissionReason,
    showToast,
    onFinish,
    onNavigate
}) => {
    const needsApp = category.scope === SYNC_SCOPES.APP;
    const missingApp = needsApp && !appId;
    const permissionBlocked = typeof permissionReason === 'string' && permissionReason.length > 0;
    const blocked = missingApp || disabled === true || permissionBlocked;

    // Every action closure is built from this, so it is memoized rather than rebuilt per render.
    const ctx = useMemo(() => ({ appId, showToast }), [appId, showToast]);

    const handleInline = useCallback((action) => {
        // No job row exists for an inline action, so there is nothing for onFinish to refresh.
        action.run(ctx);
    }, [ctx]);

    const when = _fmtWhen(lastSuccess && lastSuccess.completed_at);

    // ── Last success ─────────────────────────────────────────────────────────────────────────
    // Hoisted out of the JSX: three outcomes, and the third one (unknown) is a different CLAIM
    // rather than a different string.
    let lastSuccessTone = 'caution';
    let lastSuccessText = 'Never completed successfully';
    if (when) {
        lastSuccessTone = 'subdued';
        let scope = 'Last success (any app)';
        if (lastSuccessLabel) {
            scope = lastSuccessLabel;
        }
        lastSuccessText = `${scope}: ${when}`;
    }
    if (!when && lastSuccessUnknownReason) {
        lastSuccessTone = 'subdued';
        lastSuccessText = `Last success: — · ${lastSuccessUnknownReason}`;
    }

    // ── Why the buttons are off ──────────────────────────────────────────────────────────────
    // Several reasons can hold at once (no permission AND nothing configured AND no app picked), and
    // each is separately actionable, so they are listed rather than collapsed into whichever was
    // checked first. The permission comes first: while it holds, the other two are moot for this user.
    const blockedNotes = [];
    if (permissionBlocked) {
        blockedNotes.push({ key: 'permission', text: permissionReason });
    }
    if (disabled === true && disabledReason) {
        blockedNotes.push({ key: 'disabled', text: disabledReason });
    }
    if (missingApp) {
        blockedNotes.push({ key: 'no_app', text: 'Pick a partner app in the side nav to enable these.' });
    }

    let blockedMarkup = null;
    if (blockedNotes.length > 0) {
        blockedMarkup = (
            <BlockStack gap="100">
                {blockedNotes.map((note) => (
                    <Text key={note.key} as="span" variant="bodySm" tone="caution">{note.text}</Text>
                ))}
            </BlockStack>
        );
    }

    // ── The action row ───────────────────────────────────────────────────────────────────────
    let actionsMarkup = (
        <BlockStack gap="200">
            <InlineStack gap="200" wrap>
                {category.actions.map((action) => {
                    if (action.kind === 'inline') {
                        return (
                            <Button
                                key={action.key}
                                variant={action.variant || 'tertiary'}
                                disabled={blocked}
                                onClick={() => handleInline(action)}
                            >
                                {action.label}
                            </Button>
                        );
                    }
                    // 'job' and 'endpoint' differ only in HOW the job is enqueued —
                    // both answer the same envelope, so both poll to completion.
                    let triggerProps = {};
                    if (action.kind === 'endpoint') {
                        triggerProps = { trigger: action.makeTrigger(ctx) };
                    } else {
                        triggerProps = { jobType: action.jobType, payload: action.payload(ctx) };
                    }
                    return (
                        <ManualSyncButton
                            key={action.key}
                            {...triggerProps}
                            label={action.label}
                            variant={action.variant}
                            disabled={blocked}
                            onFinish={onFinish}
                        />
                    );
                })}
            </InlineStack>
            {category.actions.map((action) => {
                if (!action.helpText) {
                    return null;
                }
                return (
                    <Box key={`${action.key}_help`}>
                        <Text as="span" variant="bodyXs" tone="subdued">
                            {`${action.label} — ${action.helpText}`}
                        </Text>
                    </Box>
                );
            })}
            {blockedMarkup}
        </BlockStack>
    );

    // An ENTITY-scoped job is triggered from the entity's own page, because a manual run needs to
    // know WHICH one. The card still exists so the inventory stays complete.
    if (category.scope === SYNC_SCOPES.ENTITY) {
        actionsMarkup = (
            <InlineStack gap="300" blockAlign="center" wrap>
                <Text as="span" variant="bodySm" tone="subdued">{category.entity_hint}</Text>
                {/* The CTA is CONDITIONAL because the inventory deliberately outlives the pages.
                    This card row exists so the sync inventory stays complete — including job types
                    this build ships no handler for — but a category whose page is not in this build
                    has nowhere to send the operator, and `onNavigate` to a route that does not exist
                    is a 404 reached from a working screen. Two cards shipped exactly that way.
                    A category states its destination by HAVING an `entity_url`; absent, the hint
                    stands alone and says why. */}
                {category.entity_url && category.entity_cta ? (
                    <Button variant="plain" onClick={() => onNavigate(category.entity_url)}>
                        {category.entity_cta}
                    </Button>
                ) : null}
            </InlineStack>
        );
    }

    return (
        <Card>
            <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="start" wrap={false} gap="400">
                    <BlockStack gap="100">
                        {/* InlineStack, not BlockStack: a Badge laid out in a BlockStack
                            stretches to the full column width and reads as a slab. */}
                        <InlineStack gap="200" blockAlign="center">
                            <Text as="h3" variant="headingMd">{category.title}</Text>
                            <Badge tone="info">{category.job_type}</Badge>
                        </InlineStack>
                        <Text as="p" variant="bodySm" tone="subdued">{category.description}</Text>
                    </BlockStack>
                </InlineStack>

                <InlineStack gap="400" wrap>
                    <Text as="span" variant="bodySm" tone="subdued">
                        {`Schedule: ${category.cron}`}
                    </Text>
                    <Text as="span" variant="bodySm" tone={lastSuccessTone}>
                        {lastSuccessText}
                    </Text>
                </InlineStack>

                <Divider />

                {actionsMarkup}
            </BlockStack>
        </Card>
    );
};

export default SyncCategoryCard;
