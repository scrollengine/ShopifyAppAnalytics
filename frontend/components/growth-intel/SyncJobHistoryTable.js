import { Banner, Card, ResourceList, ResourceItem, Text, InlineStack, BlockStack, Pagination, EmptyState, Modal } from '@shopify/polaris';
import { useCallback, useEffect, useState } from 'react';
import SyncStatusBadge from './SyncStatusBadge';
import GrowthIntelSyncApiService from '../../API_Services/growth-intel/syncService';

const SYNC_API = new GrowthIntelSyncApiService();

/**
 * The ledger holds no job rows at all — nothing has ever been enqueued on this deployment.
 *
 *  THE ONE PLACE IN THIS SUITE WHERE A ROW COUNT IS A LEGITIMATE STATE, and the server decides it,
 * not this component. `gi_sync_jobs` has no upstream: it is written by the API on enqueue and the row
 * IS the job, so there is nothing that could have been enqueued and be missing. Every other empty
 * collection in this dashboard is ambiguous between "nothing happened" and "we never looked", which
 * is why they are decided by a watermark instead.
 */
const LEDGER_EMPTY = 'EMPTY';

const _fmtDate = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString(); } catch (e) { return String(iso); }
};

const _fmtDuration = (ms) => {
    if (ms === null || ms === undefined) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
};

/**
 * Polaris ResourceList of recent sync jobs. Server-side paginated.
 *
 * ──  AN EMPTY TABLE IS THREE DIFFERENT FACTS, AND THE PAYLOAD SEPARATES THEM ─
 * "Nothing has ever been enqueued here", "nothing matches this filter" and "the request failed" are
 * three different situations that all render as zero rows. This component used to print one
 * sentence over all three — "No sync jobs yet · Trigger a sync to see jobs appear here" — which is
 * an INSTRUCTION, and with `SYNC_DISABLED=true` it is an instruction that cannot work: the runner
 * claims nothing, so the operator can press every button on the Sync page and the ledger stays
 * exactly as empty.
 *
 * `GET /api/sync/jobs` publishes the discriminators (`ledger_state`, `sync_disabled`,
 * `pagination.total`, `warnings[]`) and answers 200 for every one of them. They are read here
 * because only the component can render them.
 *
 * @param {Object}  props
 * @param {Number}  [props.refreshKey]  - Bump to force a refetch (e.g., after a manual sync completes).
 * @param {Number}  [props.limit=20]
 * @param {String}  [props.jobType]     - Optional filter.
 * @param {String}  [props.status]      - Optional filter.
 */
const SyncJobHistoryTable = ({ refreshKey, limit, jobType, status }) => {
    const _pageSize = limit || 20;
    const [page, setPage] = useState(1);
    const [items, setItems] = useState([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [selectedJob, setSelectedJob] = useState(null);
    // Null until the first answer. Held together in ONE object so the empty state can never be
    // rendered from a half-updated mix of a fresh `items` and a stale `ledger_state`.
    const [ledger, setLedger] = useState(null);
    // The request itself did not come back. Distinct from every empty answer, because those are
    // answers — this one means the table below is showing nothing it was told.
    const [failure, setFailure] = useState('');

    const fetchJobs = useCallback(() => {
        setLoading(true);
        SYNC_API.listJobs({
            page,
            limit: _pageSize,
            job_type: jobType,
            status,
            sort: 'createdAt',
            dir: 'desc'
        }, (resp) => {
            setLoading(false);
            if (resp && resp.status && resp.data) {
                setItems(resp.data.items || []);
                setTotal((resp.data.pagination && resp.data.pagination.total) || 0);
                setLedger({
                    state: resp.data.ledger_state || '',
                    rows: resp.data.ledger_rows,
                    sync_disabled: resp.data.sync_disabled === true,
                    warnings: Array.isArray(resp.data.warnings) ? resp.data.warnings : []
                });
                setFailure('');
                return;
            }
            setItems([]);
            setTotal(0);
            setLedger(null);
            let reason = 'The job history could not be read. Check the browser console and the server logs.';
            if (resp && resp.msg) {
                reason = resp.msg;
            }
            setFailure(reason);
        });
    }, [page, _pageSize, jobType, status]);

    useEffect(() => {
        fetchJobs();
    }, [fetchJobs, refreshKey]);

    const totalPages = Math.max(Math.ceil(total / _pageSize), 1);
    const hasPrev = page > 1;
    const hasNext = page < totalPages;

    const renderItem = (job) => {
        const { job_id, job_type, status, triggered_by, completed_at, duration_ms, createdAt } = job;
        return (
            <ResourceItem
                id={job_id}
                onClick={() => setSelectedJob(job)}
                accessibilityLabel={`View job ${job_id}`}
            >
                <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="100">
                        <InlineStack gap="200" blockAlign="center">
                            <Text as="span" variant="bodyMd" fontWeight="semibold">{job_type}</Text>
                            <SyncStatusBadge status={status} />
                        </InlineStack>
                        <Text as="span" variant="bodySm" tone="subdued">
                            {`Triggered by ${triggered_by || '—'} • ${_fmtDate(createdAt)}`}
                        </Text>
                    </BlockStack>
                    <BlockStack gap="050" align="end">
                        <Text as="span" variant="bodySm">{`Duration: ${_fmtDuration(duration_ms)}`}</Text>
                        <Text as="span" variant="bodySm" tone="subdued">{`Completed: ${_fmtDate(completed_at)}`}</Text>
                    </BlockStack>
                </InlineStack>
            </ResourceItem>
        );
    };

    // ── The empty state, decided by the payload rather than by the row count ─────────────────
    //  FOUR DIFFERENT SENTENCES, AND ONLY ONE OF THEM IS AN INSTRUCTION. The instruction is
    // offered only when following it would actually work.
    let emptyHeading = 'No sync jobs yet';
    let emptyBody = 'Trigger a sync to see jobs appear here.';
    if (failure) {
        emptyHeading = 'The job history could not be read';
        emptyBody = failure;
    } else if (ledger && ledger.sync_disabled) {
        //  CHECKED BEFORE the ledger state, because it explains BOTH an empty ledger and one that
        // has simply stopped growing. Telling an operator to "trigger a sync" while the runner is
        // switched off is an instruction that cannot succeed, and they will press it repeatedly.
        emptyHeading = 'Syncing is switched off';
        emptyBody = 'SYNC_DISABLED=true, so the runner claims nothing and no schedule is armed. Nothing you trigger '
            + 'from this page will run and this list will stay exactly as it is. Unset the variable and restart '
            + 'the API.';
    } else if (ledger && ledger.state === LEDGER_EMPTY) {
        emptyHeading = 'Nothing has ever been enqueued here';
        emptyBody = 'This is a real measurement, not a gap: the job ledger is written by the API itself on enqueue, '
            + 'so an empty one means no sync has ever been started on this deployment. Trigger one from the cards '
            + 'above.';
    } else if (ledger) {
        // The ledger holds rows; this page just does not. Either a filter excludes them or the page
        // number is past the end — and "trigger a sync" would be the wrong advice for both.
        emptyHeading = 'No jobs match this view';
        emptyBody = `The ledger holds ${Number(ledger.rows || 0).toLocaleString()} job(s), but none of them is on this `
            + 'page. Clear the filters, or go back to the first page.';
    }

    // The server's own sentences — a stuck-job sweep, a filter value it did not recognise and
    // widened rather than matched, a page clamped to the end of the list. Rendered whether or not
    // there are rows: several of them are about figures that ARE on screen.
    let warningsMarkup = null;
    if (ledger && ledger.warnings.length > 0) {
        warningsMarkup = (
            <Banner tone="warning" title="About this history">
                <BlockStack gap="150">
                    {/* Keyed by the STRING: the service guarantees uniqueness for exactly this
                        reason, and two identical strings would collide and DROP one. */}
                    {ledger.warnings.map((warning) => (
                        <Text key={warning} as="p" variant="bodySm">{warning}</Text>
                    ))}
                </BlockStack>
            </Banner>
        );
    }

    return (
        <>
            {warningsMarkup}
            <Card padding="0">
                <ResourceList
                    resourceName={{ singular: 'sync job', plural: 'sync jobs' }}
                    items={items}
                    renderItem={renderItem}
                    loading={loading}
                    emptyState={
                        <EmptyState
                            heading={emptyHeading}
                            image=""
                        >
                            <p>{emptyBody}</p>
                        </EmptyState>
                    }
                />
                {total > 0 && (
                    <div style={{ padding: '12px 16px', borderTop: '1px solid #e1e3e5', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Text as="span" variant="bodySm" tone="subdued">{`Showing ${(page - 1) * _pageSize + 1}–${Math.min(page * _pageSize, total)} of ${total}`}</Text>
                        <Pagination
                            hasPrevious={hasPrev}
                            onPrevious={() => setPage((p) => Math.max(p - 1, 1))}
                            hasNext={hasNext}
                            onNext={() => setPage((p) => p + 1)}
                        />
                    </div>
                )}
            </Card>
            <Modal
                open={!!selectedJob}
                onClose={() => setSelectedJob(null)}
                title={selectedJob ? `Job ${selectedJob.job_id}` : 'Job detail'}
                primaryAction={{ content: 'Close', onAction: () => setSelectedJob(null) }}
            >
                <Modal.Section>
                    {selectedJob && (
                        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace', fontSize: 12 }}>
                            {JSON.stringify(selectedJob, null, 2)}
                        </pre>
                    )}
                </Modal.Section>
            </Modal>
        </>
    );
};

export default SyncJobHistoryTable;
