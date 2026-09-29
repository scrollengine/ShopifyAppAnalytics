import { Banner } from '@shopify/polaris';

import { forbiddenPermissionOf, isForbiddenResponse, permissionLabel } from '../../utils/permissions';
import { failureMessage } from './adminPresentation';

/**
 * The banner a tab shows when its list could not be read.
 *
 * Two different facts, kept apart: a 403 is "your role does not include this" (info, no retry,
 * because retrying cannot change the answer), anything else is "we could not ask" (critical, with
 * Try again). Neither renders an empty table: a list that failed to load is not a list with nothing
 * in it.
 *
 * @param {Object} props - Component props.
 * @param {Object} props.result - The failed `userAdminService` result.
 * @param {String} props.what - What could not be read, e.g. "The member list".
 * @param {Function} props.onRetry - Re-issues the request.
 * @returns {JSX.Element}
 */
const LoadFailureBanner = ({ result, what, onRetry }) => {
    if (isForbiddenResponse(result)) {
        const permission = forbiddenPermissionOf(result);
        return (
            <Banner tone="info" title="Restricted">
                <p>
                    {permission
                        ? `Your role does not include ${permissionLabel(permission)}, so ${what.toLowerCase()} is not shown.`
                        : failureMessage(result, `Your role does not allow reading ${what.toLowerCase()}.`)}
                </p>
            </Banner>
        );
    }
    return (
        <Banner
            tone="critical"
            title={`${what} could not be loaded`}
            action={{ content: 'Try again', onAction: onRetry }}
        >
            <p>{failureMessage(result, 'The server gave no reason. Check the server logs.')}</p>
        </Banner>
    );
};

export default LoadFailureBanner;
