import { Badge } from '@shopify/polaris';

const STATUS_TO_TONE = {
    PENDING: 'attention',
    RUNNING: 'info',
    SUCCESS: 'success',
    FAILED: 'critical',
    CANCELLED: 'warning'
};

const STATUS_TO_PROGRESS = {
    PENDING: 'incomplete',
    RUNNING: 'partiallyComplete',
    SUCCESS: 'complete',
    FAILED: 'complete',
    CANCELLED: 'complete'
};

const SyncStatusBadge = ({ status }) => {
    const _status = status || 'PENDING';
    const tone = STATUS_TO_TONE[_status] || 'new';
    const progress = STATUS_TO_PROGRESS[_status] || 'incomplete';
    return (
        <Badge tone={tone} progress={progress}>
            {_status}
        </Badge>
    );
};

export default SyncStatusBadge;
