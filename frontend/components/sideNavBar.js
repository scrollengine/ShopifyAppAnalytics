import { useContext, useState } from 'react';
import { useRouter } from 'next/router';
import { BlockStack, Box, Frame, Modal, Navigation, Select, Text, TopBar } from '@shopify/polaris';
import {
    AppsIcon,
    ArrowLeftIcon,
    CashDollarIcon,
    ChartFunnelIcon,
    ClockIcon,
    DataPresentationIcon,
    ExitIcon,
    GlobeIcon,
    HomeIcon,
    PersonRemoveIcon,
    ProfileIcon,
    RefreshIcon,
    StoreIcon,
    TeamIcon
} from '@shopify/polaris-icons';

import LoaderContext from '../contexts/loaderContext';
import { APPS_STATE, useGrowthIntel } from '../contexts/growthIntelContext';
import { useSession } from '../contexts/sessionContext';
import { ADMIN_ROUTES, DASHBOARD_ROUTES, isRouteSelected } from '../utils/dashboardRoutes';
import { canViewPage } from '../utils/permissions';

/**
 * =============================================================================
 *  The application shell: top bar, navigation, logout, and the partner-app picker.
 * =============================================================================
 *
 *   THIS FILE IS A DELIBERATE REPLACEMENT, NOT A PORT.
 *
 *  Every other file extracted from the source dashboard came across verbatim.
 *  This one did not, and could not: the original nav carried that product's ENTIRE
 *  navigation — Dashboard, Users, admin Stores, Global Plans, Features Requested,
 *  Contacted Us, Newsletter, the Market Intel scrapers, Insights/Chat, Health and
 *  a Campaign section — none of which exists here. Porting it would have produced
 *  a menu of roughly twenty dead links, and every one of them would have looked
 *  like a broken page rather than a page that was never part of this project.
 *
 *  So the markup idiom is kept (Polaris `Frame` + `Navigation.Section`s, the picker
 *  as a `Box` between sections, the confirm-logout modal, the shared `toastMarkup`)
 *  and only the item list is rewritten, down to the Overview, the seven
 *  Performance pages, the two Setup screens and the one Administration screen.
 *
 *  ── EVERY ROW IS FILTERED BY THE ROLE ───────────────────────────────────────
 *  A row is drawn only when `canViewPage(permissions, url)` says the signed-in
 *  role opens that page — the SAME predicate `_app.js` uses to decide whether to
 *  mount it, so the nav can never offer a page the gate then refuses. A section
 *  left with no rows is not drawn at all (an empty "Setup" heading reads as a
 *  bug). This is presentation only; the backend refuses every call the role does
 *  not cover, whatever the nav shows.
 *
 *  ── WHAT IS HELD FIXED, AND WHY ─────────────────────────────────────────────
 *  The component's NAME, its default export, and its props (`children`, `loginPage`)
 *  are identical to the original. Every page wraps itself in `<SideNavBar>` and
 *  imports it by that name from this path, so holding the signature meant the
 *  ported pages needed no edit at all during the extraction. Ten files import it
 *  today: change the shape here and you change all ten.
 *
 *  ── WHAT WAS DROPPED FROM THE ORIGINAL SHELL ────────────────────────────────
 *  · The `logo` prop — it pointed at a branded PNG belonging to the source product.
 *    There is no logo asset in this repository, and shipping someone else's mark in
 *    an open-source project is not a detail to leave dangling.
 *  · `AppFooter` — the source product's wordmark and copyright line.
 *  · The `CustomModal` wrapper — one indirection over Polaris `Modal` for a single
 *    call site. The modal below is the same markup with one less file to carry.
 *
 *  ── SIGNING OUT GOES THROUGH THE SESSION ────────────────────────────────────
 *  Both ways out — the "Logout" row and the user menu's "Log out" — open the same
 *  confirm modal, and confirming calls `session.logout()`: it ends this session on
 *  the SERVER (the backend keeps a session table, so dropping the token alone
 *  would leave it valid until it expired), then drops the token and reloads onto
 *  /login. See `contexts/sessionContext.js`.
 * =============================================================================
 */

/**
 * Up to two initials for the user-menu avatar, from the display name.
 *
 * @param {String} name - The user's name. May be empty.
 * @returns {String|undefined} Uppercase initials, or undefined so the Avatar draws its default.
 */
const _initialsOf = (name) => {
    if (typeof name !== 'string') {
        return undefined;
    }
    const letters = name
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((word) => word.charAt(0).toUpperCase())
        .join('');
    return letters || undefined;
};

/**
 * The application shell. Wraps every authenticated page.
 *
 * @param {Object} props - Component props.
 * @param {React.ReactNode} props.children - The page content rendered inside the Frame.
 * @param {Boolean} props.loginPage - True on the login screen: suppresses the navigation
 * so an unauthenticated visitor is not shown a menu of pages they cannot open.
 * @returns {JSX.Element} The framed application shell.
 */
const SideNavBar = ({ children, loginPage }) => {
    const { apps, appId, setAppId, appsState, isGrowthRoute } = useGrowthIntel();
    const session = useSession();
    const router = useRouter();
    const { toastMarkup } = useContext(LoaderContext);

    const [confirmLogoutModal, setConfirmLogoutModal] = useState(false);
    const [loggingOut, setLoggingOut] = useState(false);
    const [mobileNavigationActive, setMobileNavigationActive] = useState(false);
    const [userMenuOpen, setUserMenuOpen] = useState(false);

    const pathname = router.pathname || '';
    const permissions = session.permissions;

    const toggleMobileNavigationActive = () => {
        setMobileNavigationActive((active) => !active);
    };

    /**
     * Ends the session through `session.logout()` — server first, best effort, then a full-document
     * reload onto /login.
     *
     * The reload (inside `logout`) is deliberate: the in-memory caches — the partner-app roster, the
     * account, whatever each page holds — survive a client-side navigation, so an SPA logout would
     * leave the previous user's data sitting in the tab. It is also what the axios 401 interceptor
     * does, so both ways out of a session behave identically.
     *
     * @returns {void}
     */
    const logout = () => {
        setLoggingOut(true);
        session.logout();
    };

    /**
     * Keeps only the rows the signed-in role can open. See the file header.
     *
     * @param {Array<Object>} items - Navigation items, each with a route `url`.
     * @returns {Array<Object>}
     */
    const _visible = (items) => items.filter((item) => canViewPage(permissions, item.url));

    /* The partner app scopes EVERY page in this section, so it belongs to the section rather
       than to any one screen. It used to be a card at the top of every page, each with its
       own state and its own app-list request — so the selection reset on navigation and the
       same roster was refetched a dozen times. Rendered only on growth routes: the login
       screen has no idea what a partner app is and must not show a picker for one. */
    let partnerAppPicker = null;
    if (isGrowthRoute) {
        let pickerBody = (
            <Select
                label="Partner app"
                labelHidden
                options={apps.map((a) => ({ label: a.display_name, value: a.app_id }))}
                value={appId}
                onChange={(v) => setAppId(v)}
            />
        );

        // AN EMPTY PICKER IS FOUR DIFFERENT FACTS AND ONLY ONE OF THEM IS ABOUT THE ACCOUNT.
        // This read `if (appsLoading) 'Loading…' else 'No partner apps yet'`, and `appsLoading` is
        // FALSE once a request has failed — so a 500 or a dropped connection printed "No partner
        // apps yet" in the nav of every page in the section at once. That is a measured claim about
        // the operator's business manufactured out of a transport failure, which is the §4.5
        // regression one layer further out than the pages hardened against it.
        //
        // `appsState` is the discriminator, exactly as on the pages (see `growthIntelContext`):
        // READY is the only state in which `[]` means "you have no apps". PENDING is the first tick
        // and the in-flight request; ERROR says the list is unavailable and says nothing about how
        // many apps exist; UNAUTHENTICATED draws NO PICKER AT ALL, because the redirect to /login is
        // already under way and a nav control captioned with anything at all reads as a live screen.
        //
        // ⚠️ Only the EMPTY branch is state-gated. A non-empty `apps` is a roster we measured, and
        // the provider deliberately keeps it through a failed refresh — so the Select still renders
        // (possibly stale) rather than being replaced by a claim we cannot support.
        if (apps.length === 0) {
            let emptyLabel = 'Loading…';
            if (appsState === APPS_STATE.READY) {
                emptyLabel = 'No partner apps yet';
            } else if (appsState === APPS_STATE.ERROR) {
                emptyLabel = 'App list unavailable';
            }
            pickerBody = appsState === APPS_STATE.UNAUTHENTICATED
                ? null
                : (<Text as="span" variant="bodySm" tone="subdued">{emptyLabel}</Text>);
        }

        if (pickerBody) {
            partnerAppPicker = (
                <Box paddingInlineStart="400" paddingInlineEnd="400" paddingBlockStart="400">
                    {/* BlockStack's default align-items: stretch is wanted here — the Select should
                        fill the nav column. Do not add inlineAlign="start"; it would shrink the
                        control to its content width and leave it floating in the gutter. */}
                    <BlockStack gap="100">
                        <Text as="span" variant="bodyXs" tone="subdued">PARTNER APP</Text>
                        {pickerBody}
                    </BlockStack>
                </Box>
            );
        }
    }

    // The rows are built first and filtered, then only non-empty sections are drawn. Building them
    // inline inside `items={...}` would leave an empty "Setup" or "Administration" heading on screen
    // for a role that opens nothing under it.
    const performanceItems = _visible([
        {
            // ⚠️ EVERY ROW'S URL COMES FROM `utils/dashboardRoutes.js`, and so does the
            // predicate that highlights it. Those paths are also what the partner-app
            // context tests to decide whether to fetch the roster at all, and a nav that
            // linked somewhere the context did not recognise would open a page whose
            // every figure reads "No partner app is selected" — with no error anywhere.
            // One list is what makes that drift impossible.
            //
            // FIRST ITEM OF PERFORMANCE RATHER THAN AN ENTRY OF ITS OWN ABOVE THE
            // PICKER: the Overview shows one partner app's installs and revenue, so it
            // is scoped by the picker exactly as the seven below it are. Anything sitting
            // ABOVE that control reads as unscoped, which would be a claim this page
            // cannot honour.
            //
            // ⚠️ THE PAGE THIS ROW OPENS CARRIES A SECOND COPY OF THIS LIST.
            // `SECTION_CONTENTS` in `pages/overview/index.js` repeats every label
            // and href below, in this order and these groups, with a sentence
            // saying what each screen answers — and it carries three Revenue entries
            // where this nav carries one row, because a contents card can name a TAB
            // and a nav row cannot (see the Revenue row below) — because the Overview's commonest state
            // on a fresh install is a banner pointing at Partner Apps or Sync, and a
            // nav label cannot carry that sentence. The HREFS are shared now, so those
            // cannot drift; the LABELS and the ORDER are still kept by hand: ADD OR
            // RENAME A ROW HERE AND CHANGE IT THERE IN THE SAME EDIT. It is filtered by
            // the same `canViewPage` as these rows, so the two agree on WHO sees a row too.
            url: DASHBOARD_ROUTES.OVERVIEW,
            label: 'Overview',
            icon: DataPresentationIcon,
            selected: isRouteSelected(DASHBOARD_ROUTES.OVERVIEW, pathname)
        },
        {
            url: DASHBOARD_ROUTES.FUNNEL,
            label: 'Funnel',
            icon: ChartFunnelIcon,
            selected: isRouteSelected(DASHBOARD_ROUTES.FUNNEL, pathname)
        },
        {
            url: DASHBOARD_ROUTES.TRAFFIC_SOURCES,
            label: 'Traffic Sources',
            icon: GlobeIcon,
            selected: isRouteSelected(DASHBOARD_ROUTES.TRAFFIC_SOURCES, pathname)
        },
        {
            url: DASHBOARD_ROUTES.TRIAL_FUNNEL,
            label: 'Trial Funnel',
            icon: ClockIcon,
            selected: isRouteSelected(DASHBOARD_ROUTES.TRIAL_FUNNEL, pathname)
        },
        {
            url: DASHBOARD_ROUTES.LOGO_CHURN,
            label: 'Logo Churn',
            icon: PersonRemoveIcon,
            selected: isRouteSelected(DASHBOARD_ROUTES.LOGO_CHURN, pathname)
        },
        {
            url: DASHBOARD_ROUTES.STORES,
            label: 'Stores',
            icon: HomeIcon,
            selected: isRouteSelected(DASHBOARD_ROUTES.STORES, pathname)
        },
        {
            url: DASHBOARD_ROUTES.SUBSCRIPTIONS,
            label: 'Subscriptions',
            icon: StoreIcon,
            selected: isRouteSelected(DASHBOARD_ROUTES.SUBSCRIPTIONS, pathname)
        },
        {
            // ── ONE ROW WHERE THERE WERE THREE ──────────────────────────────────
            // Revenue, Revenue Country and Revenue Churn were three rows opening three
            // pages. They are three TABS of `/revenue` now, under one shared date
            // range, so the nav carries one row and the tab strip carries the rest.
            //
            // ⚠️ NO SECOND ROW PER TAB, and it would be easy to add one: a row per
            // `revenueViewHref(...)` would look tidier in the menu and would be wrong.
            // `selected` is decided from `router.pathname`, which is `/revenue` on all
            // three views — so three rows would light up together on every tab, and the
            // reader would have no way to tell which view they were on from the nav.
            //
            // ⚠️ THIS ROW USED TO PROVE `isRouteSelected` EARNS ITS PLACE:
            // '/revenue-churn' starts with '/revenue', so a plain `startsWith` lit BOTH
            // rows whenever you were reading Revenue Churn. That path is a redirect
            // source now and can never be a `router.pathname`, so the collision is
            // gone — but the helper stays, because the NEXT sibling that shares a word
            // gets the fix for free. See `utils/dashboardRoutes.js`.
            url: DASHBOARD_ROUTES.REVENUE,
            label: 'Revenue',
            icon: CashDollarIcon,
            selected: isRouteSelected(DASHBOARD_ROUTES.REVENUE, pathname)
        }
    ]);

    const setupItems = _visible([
        {
            url: DASHBOARD_ROUTES.APPS,
            label: 'Partner Apps',
            icon: AppsIcon,
            selected: isRouteSelected(DASHBOARD_ROUTES.APPS, pathname)
        },
        {
            url: DASHBOARD_ROUTES.SYNC,
            label: 'Sync',
            icon: RefreshIcon,
            selected: isRouteSelected(DASHBOARD_ROUTES.SYNC, pathname)
        }
    ]);

    // Administration: not partner-app scoped, so these routes live in `ADMIN_ROUTES`, never in
    // `DASHBOARD_ROUTES` — see `utils/dashboardRoutes.js`. `/account` is not a row here: it is every
    // user's own page and lives in the top bar's user menu.
    const adminItems = _visible([
        {
            url: ADMIN_ROUTES.USERS,
            label: 'Users & roles',
            icon: TeamIcon,
            selected: isRouteSelected(ADMIN_ROUTES.USERS, pathname)
        }
    ]);

    let performanceSection = null;
    if (performanceItems.length > 0) {
        performanceSection = <Navigation.Section separator title="Performance" items={performanceItems} />;
    }

    // Setup, not Performance: these two configure and feed the dataset the Performance pages read.
    // Kept after Performance because they are visited on day one and rarely after.
    let setupSection = null;
    if (setupItems.length > 0) {
        setupSection = <Navigation.Section separator title="Setup" items={setupItems} />;
    }

    let adminSection = null;
    if (adminItems.length > 0) {
        adminSection = <Navigation.Section separator title="Administration" items={adminItems} />;
    }

    const navigationMarkup = (
        <Navigation location="/">
            <Navigation.Section
                items={[
                    {
                        label: 'Logout',
                        icon: ArrowLeftIcon,
                        onClick: () => setConfirmLogoutModal(true)
                    }
                ]}
            />
            {partnerAppPicker}
            {performanceSection}
            {setupSection}
            {adminSection}
        </Navigation>
    );

    // ── The user menu ────────────────────────────────────────────────────────────────────────
    // Name and role label from the session. "Log out" opens the same confirm modal as the nav row, so
    // both ways out ask once and behave identically.
    let userMenuMarkup;
    if (session.user) {
        let displayName = session.user.name;
        if (!displayName) {
            displayName = session.user.email;
        }
        let roleLabel;
        if (session.role && session.role.label) {
            roleLabel = session.role.label;
        }
        userMenuMarkup = (
            <TopBar.UserMenu
                name={displayName}
                detail={roleLabel}
                initials={_initialsOf(displayName)}
                open={userMenuOpen}
                onToggle={() => setUserMenuOpen((open) => !open)}
                actions={[
                    {
                        items: [
                            {
                                content: 'Account',
                                icon: ProfileIcon,
                                onAction: () => {
                                    setUserMenuOpen(false);
                                    router.push(ADMIN_ROUTES.ACCOUNT);
                                }
                            }
                        ]
                    },
                    {
                        items: [
                            {
                                content: 'Log out',
                                icon: ExitIcon,
                                onAction: () => {
                                    setUserMenuOpen(false);
                                    setConfirmLogoutModal(true);
                                }
                            }
                        ]
                    }
                ]}
            />
        );
    }

    return (
        <Frame
            topBar={(
                <TopBar
                    showNavigationToggle
                    userMenu={loginPage ? undefined : userMenuMarkup}
                    onNavigationToggle={toggleMobileNavigationActive}
                />
            )}
            navigation={!loginPage && navigationMarkup}
            showMobileNavigation={mobileNavigationActive}
            onNavigationDismiss={toggleMobileNavigationActive}
        >
            {children}
            <Modal
                size="small"
                open={confirmLogoutModal}
                onClose={() => setConfirmLogoutModal(false)}
                title="Confirm Logout"
                primaryAction={{ content: 'Cancel', onAction: () => setConfirmLogoutModal(false) }}
                secondaryActions={[{ content: 'Logout', onAction: logout, loading: loggingOut, disabled: loggingOut }]}
            >
                <Modal.Section><p>Are you sure you want to log out?</p></Modal.Section>
            </Modal>
            {/* Rendered here rather than by each page: a Polaris Toast must sit inside a Frame,
                and this is the only Frame in the app. See the LoaderContext value in _app.js. */}
            {toastMarkup}
        </Frame>
    );
};

export default SideNavBar;
