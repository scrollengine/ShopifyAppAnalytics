import { Button } from '@shopify/polaris';
import { useCallback, useContext, useRef, useState } from 'react';
import LoaderContext from '../../contexts/loaderContext';
import GrowthIntelSyncApiService from '../../API_Services/growth-intel/syncService';

const SYNC_API = new GrowthIntelSyncApiService();

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_MS = 5 * 60 * 1000;
const TERMINAL_STATUSES = ['SUCCESS', 'FAILED', 'CANCELLED'];

/**
 * Reusable manual-sync trigger button: enqueue, then poll to a terminal status.
 *
 * ⚠️ THERE IS NO `POST /sync/trigger` ON THIS BACKEND, and there never was — this docblock used to
 * name one, along with a `POST /funnel/attribution/sync` that also does not exist. The CODE was
 * always right; only these sentences were wrong, which is the worst way for a comment to be wrong:
 * the next reader looks for a route, does not find it, and starts doubting the thing that works.
 *
 * What actually happens: `_enqueue` calls `syncService.triggerSync({ job_type, payload })`, and that
 * method DISPATCHES on the type to the matching dedicated route — PARTNER_SYNC → `sync/partner`,
 * BIGQUERY_SYNC → `sync/bigquery`, INSTALL_ATTRIBUTION_SYNC → `sync/install-attribution`, DUMMY →
 * `sync/dummy` — and refuses any other type by name rather than quietly running a different sync.
 * Every one of those routes answers the same `{ status, data: { job: { job_id } } }` envelope, which
 * is why the polling below does not care which was reached.
 *
 * Then `GET /api/sync/jobs/:job_id` every 2s until the status is terminal (SUCCESS / FAILED /
 * CANCELLED) or the five-minute deadline passes — at which point the job KEEPS RUNNING and the toast
 * says so, because nothing here can stop it. The Sync page's lookup box is how it is found again.
 *
 *  A 200 FROM THE ENQUEUE MEANS *QUEUED*, NOT *SYNCED*. Nothing in this component reports success
 * off the trigger response; it reports it off a terminal job row, which is the only thing that says
 * anything ran.
 *
 * @param {Object}   props
 * @param {String}   props.jobType - SYNC_JOB_TYPES value (e.g., 'DUMMY', 'PARTNER_SYNC'). Dispatched
 *   by `syncService.triggerSync`; a type with no route is refused rather than substituted.
 * @param {Object}   [props.payload] - Job-specific payload.
 * @param {Function} [props.trigger] - Optional enqueue override, `(cb) => void`. Use it when the
 *   caller needs a shape `triggerSync` does not take — the attribution dry run, or a LIFETIME mode
 *   flag — by calling the dedicated service method directly. The override must answer the same
 *   `{status, data:{job:{job_id}}}` envelope, because the polling below is unchanged. `jobType` is
 *   then optional.
 * @param {String}   [props.label] - Button label (default "Sync now").
 * @param {String}   [props.variant] - Polaris Button variant (default "primary").
 * @param {Function} [props.onSuccess] - Called with serialized job on SUCCESS.
 * @param {Function} [props.onFinish]  - Called regardless of terminal outcome, INCLUDING with `null`
 *   when the enqueue was refused or the poll deadline passed.
 * @param {Boolean}  [props.disabled]
 */
const ManualSyncButton = ({
    jobType,
    payload,
    trigger,
    label,
    variant,
    onSuccess,
    onFinish,
    disabled
}) => {
    const { showToast } = useContext(LoaderContext) || {};
    const [isSyncing, setIsSyncing] = useState(false);
    const pollTimerRef = useRef(null);
    const pollDeadlineRef = useRef(0);

    const _clearPoll = () => {
        if (pollTimerRef.current) {
            clearTimeout(pollTimerRef.current);
            pollTimerRef.current = null;
        }
    };

    const _finish = useCallback((job) => {
        _clearPoll();
        setIsSyncing(false);
        if (typeof onFinish === 'function') {
            try { onFinish(job); } catch (e) { console.error('onFinish callback error', e); }
        }
    }, [onFinish]);

    const _pollJob = useCallback((jobId) => {
        if (Date.now() > pollDeadlineRef.current) {
            if (showToast) {
                showToast('Sync is taking longer than expected. It will continue in the background.', true);
            }
            _finish(null);
            return;
        }
        SYNC_API.getJob(jobId, (resp) => {
            if (!resp || resp.resource_access === 'NOT_ALLOWED') {
                if (showToast) {
                    showToast('Permission denied. Please log in as super admin.', true);
                }
                _finish(null);
                return;
            }
            const job = resp && resp.status && resp.data ? resp.data.job : null;
            if (!job) {
                pollTimerRef.current = setTimeout(() => _pollJob(jobId), POLL_INTERVAL_MS);
                return;
            }
            if (!TERMINAL_STATUSES.includes(job.status)) {
                pollTimerRef.current = setTimeout(() => _pollJob(jobId), POLL_INTERVAL_MS);
                return;
            }
            if (job.status === 'SUCCESS') {
                if (showToast) {
                    showToast(`Sync completed in ${Math.round((job.duration_ms || 0) / 1000)}s`, false);
                }
                if (typeof onSuccess === 'function') {
                    try { onSuccess(job); } catch (e) { console.error('onSuccess callback error', e); }
                }
            } else {
                const reason = job.error_message || job.failure_reason || job.status;
                if (showToast) {
                    showToast(`Sync ${job.status.toLowerCase()}: ${reason}`, true);
                }
            }
            _finish(job);
        });
    }, [_finish, onSuccess, showToast]);

    // `triggerSync` dispatches the job type to its own route (there is no generic trigger endpoint —
    // see the docblock), unless the caller handed us an override for a shape it does not take. Both
    // answer the same envelope, so everything after the enqueue is identical.
    const _enqueue = useCallback((cb) => {
        if (typeof trigger === 'function') {
            trigger(cb);
            return;
        }
        SYNC_API.triggerSync({ job_type: jobType, payload: payload || {} }, cb);
    }, [trigger, jobType, payload]);

    const handleClick = useCallback(() => {
        if (!jobType && typeof trigger !== 'function') {
            console.error('ManualSyncButton: jobType is required (or pass a trigger)');
            return;
        }
        setIsSyncing(true);
        pollDeadlineRef.current = Date.now() + MAX_POLL_MS;
        _enqueue((resp) => {
            if (!resp || resp.resource_access === 'NOT_ALLOWED') {
                if (showToast) {
                    showToast('Permission denied. Please log in as super admin.', true);
                }
                _finish(null);
                return;
            }
            if (!resp.status || !resp.data || !resp.data.job || !resp.data.job.job_id) {
                if (showToast) {
                    showToast(resp.msg || 'Failed to start sync.', true);
                }
                _finish(null);
                return;
            }
            if (showToast) {
                showToast('Sync started.', false);
            }
            _pollJob(resp.data.job.job_id);
        });
        // `payload` is read inside _enqueue now, so it travels through that dependency.
    }, [jobType, trigger, _enqueue, showToast, _pollJob, _finish]);

    return (
        <Button
            variant={variant || 'primary'}
            loading={isSyncing}
            disabled={disabled || isSyncing}
            onClick={handleClick}
        >
            {label || 'Sync now'}
        </Button>
    );
};

export default ManualSyncButton;
