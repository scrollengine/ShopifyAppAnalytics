import { Banner, BlockStack, Card, Page, Tabs } from '@shopify/polaris';
import { useCallback, useMemo } from 'react';
import { useRouter } from 'next/router';

import SideNavBar from '../../components/sideNavBar';
import MembersTab from '../../components/admin/MembersTab';
import InvitationsTab from '../../components/admin/InvitationsTab';
import RolesTab from '../../components/admin/RolesTab';
import ActivityTab from '../../components/admin/ActivityTab';
import useAdminSession from '../../components/admin/useAdminSession';
import { PERMISSIONS, permissionLabel } from '../../utils/permissions';
import {
    DEFAULT_USERS_VIEW,
    USERS_VIEWS,
    USERS_VIEW_ORDER,
    normaliseUsersView,
    usersViewHref
} from '../../utils/dashboardRoutes';

/**
 * =============================================================================
 *  Users & roles: members, invitations, roles and the security activity log.
 * =============================================================================
 *
 *  Opened with `users:read` (the gate in `_app.js` renders "Restricted" without
 *  mounting this page otherwise). Every action beyond reading is gated twice:
 *  by the session's permissions here, and by the server on every call, which
 *  also applies the management rule (you act only on people whose role is
 *  strictly below yours). The screen decides what to OFFER; the server decides
 *  what is ALLOWED.
 *
 *  The tab lives in the URL (`?view=members|invites|roles|activity`), the same
 *  pattern and the same reasons as `/revenue`: see `USERS_VIEWS` in
 *  `utils/dashboardRoutes.js`. One tab is mounted at a time and each tab owns
 *  its own requests, so a tab nobody opened issues none.
 * =============================================================================
 */

/** What each view is called on the strip. */
const TAB_LABELS = Object.freeze({
    [USERS_VIEWS.MEMBERS]: 'Members',
    [USERS_VIEWS.INVITES]: 'Invitations',
    [USERS_VIEWS.ROLES]: 'Roles',
    [USERS_VIEWS.ACTIVITY]: 'Activity'
});

/**
 * The Users & roles screen.
 *
 * @returns {JSX.Element} The framed page.
 */
const UsersPage = () => {
    const router = useRouter();
    const { can } = useAdminSession();
    const canReadAudit = can(PERMISSIONS.AUDIT_READ);

    /**
     * The views this user may open, in strip order. Activity needs `audit:read`; the other three
     * need only `users:read`, which opening this page already implies.
     *
     * ⚠️ MEMOISED, AND THE TAB ARRAY WITH IT. Polaris re-runs a tab's focus effect whenever its
     * `content` reference changes; an inline array rebuilt on every render yanks focus from the
     * invite form's fields to the tab strip on each keystroke once a tab has been clicked.
     */
    const visibleViews = useMemo(
        () => USERS_VIEW_ORDER.filter((view) => view !== USERS_VIEWS.ACTIVITY || canReadAudit),
        [canReadAudit]
    );
    const tabs = useMemo(() => visibleViews.map((view) => ({
        // Namespaced so a tab id cannot collide with another element id on the page.
        id: `users-view-${view}`,
        content: TAB_LABELS[view] || view
    })), [visibleViews]);

    // Null until the router can say which view the URL asks for: deriving from an empty query would
    // mount Members for one tick and fire its requests before a deep link to another tab took over.
    const requested = router.isReady ? normaliseUsersView(router.query.view) : null;

    // A link to Activity opened by someone without `audit:read`: say so, and show the default view
    // rather than an empty panel under a strip with nothing selected.
    const activityRestricted = requested === USERS_VIEWS.ACTIVITY && !canReadAudit;
    let view = requested;
    if (activityRestricted) {
        view = DEFAULT_USERS_VIEW;
    }

    let selectedIndex = 0;
    if (view && visibleViews.indexOf(view) >= 0) {
        selectedIndex = visibleViews.indexOf(view);
    }

    /**
     * Switch tabs by navigating, because the tab is a URL. `push` so Back returns to the previous
     * tab; `shallow` because nothing on this route is fetched server-side.
     *
     * @param {Number} index - The tab index Polaris selected.
     * @returns {void}
     */
    const handleSelectTab = useCallback((index) => {
        const next = visibleViews[index];
        if (!next) {
            return;
        }
        // Polaris fires onSelect for the already-selected tab too; pushing would stack a duplicate
        // history entry that makes the next Back press appear to do nothing.
        if (next === requested) {
            return;
        }
        router.push(usersViewHref(next), undefined, { shallow: true });
    }, [router, requested, visibleViews]);

    let panel = null;
    if (view === USERS_VIEWS.MEMBERS) {
        panel = <MembersTab />;
    } else if (view === USERS_VIEWS.INVITES) {
        panel = <InvitationsTab />;
    } else if (view === USERS_VIEWS.ROLES) {
        panel = <RolesTab />;
    } else if (view === USERS_VIEWS.ACTIVITY && canReadAudit) {
        panel = <ActivityTab />;
    }

    return (
        <SideNavBar>
            <Page
                title="Users & roles"
                subtitle="Who can sign in, what each role may see and do, and the security activity log."
                fullWidth
            >
                <BlockStack gap="400">
                    {activityRestricted ? (
                        <Banner tone="info" title="Activity is restricted">
                            <p>{`Your role does not include ${permissionLabel(PERMISSIONS.AUDIT_READ)}, so the Activity tab is not available.`}</p>
                        </Banner>
                    ) : null}

                    {view ? (
                        <Card padding="0">
                            <Tabs tabs={tabs} selected={selectedIndex} onSelect={handleSelectTab} />
                        </Card>
                    ) : null}

                    {panel}
                </BlockStack>
            </Page>
        </SideNavBar>
    );
};

export default UsersPage;
