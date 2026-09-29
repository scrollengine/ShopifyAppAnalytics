import { Badge, Banner, BlockStack, Box, Button, Card, Divider, InlineGrid, InlineStack, Link, Page, Text } from '@shopify/polaris';
import { useCallback, useContext, useState } from 'react';
import SideNavBar from '../../components/sideNavBar';
import LoaderContext from '../../contexts/loaderContext';
import { APPS_STATE, useGrowthIntel } from '../../contexts/growthIntelContext';
import { useSession } from '../../contexts/sessionContext';
import PartnerAppForm from '../../components/growth-intel/PartnerAppForm';
import { DASHBOARD_ROUTES } from '../../utils/dashboardRoutes';
import { PERMISSIONS, canViewPage, permissionLabel } from '../../utils/permissions';

/**
 * =============================================================================
 *  Partner Apps — the first screen of a fresh install, and the only way in.
 * =============================================================================
 *
 *   THIS IS THE FIRST-RUN SCREEN. Every other page in this dashboard is scoped
 *  by a partner app, and the picker in the side nav can only offer apps that are
 *  already registered. On a fresh install there are none, so a reader who lands
 *  anywhere else sees nine pages of "no data" with nothing telling them why. The
 *  empty state below is therefore the primary design, not a fallback: it explains
 *  what a partner app IS, why the id cannot be chosen here, and puts the form on
 *  screen without a click.
 *
 *  ── ⚠️ THE FORM ASKS FOR AN APP ID THIS BACKEND CANNOT HONOUR ────────────────
 *  `PartnerAppForm` was extracted from a dashboard whose API registered whatever
 *  app id the form posted. This backend cannot: the Shopify Partner GraphQL API
 *  has no `apps` connection and no lookup by handle or API key, so the id has to
 *  come from configuration — `SHOPIFY_PARTNER_APP_ID` in the backend's `.env` —
 *  or from nowhere. `POST /api/partner-apps` therefore takes DISPLAY metadata
 *  only (`app_handle`, `display_name`, `listing_url`) and registers the
 *  configured app.
 *
 *  The form's "Shopify Partner API App ID", "Categories", "Initial target
 *  keywords" and "Active" fields are consequently NOT stored. That is stated on
 *  screen rather than left for the operator to discover from a value that did not
 *  change, and the app that was ACTUALLY registered is shown back to them after
 *  the save — see `handleSaved`.
 *
 *  ── ⚠️ THE INSTALL AND REVENUE KPIs LIVE ON THE OVERVIEW, NOT HERE ──────────
 *  This page used to read `GET /api/partner-apps/:id/kpi` itself and render the
 *  KPI tiles, the caveats card and the install-activity chart under the roster.
 *  The Overview (`/overview`, which is also the post-login landing) renders the
 *  SAME three components from the SAME read, so the block here was DELETED —
 *  not hidden, not gated. `AppKpiCards`, `KpiWarningsCard` and
 *  `InstallTrendSection` now have exactly one call site between them, the
 *  Overview, and this page no longer calls `/kpi` at all.
 *
 *  Why deletion and not duplication: two screens publishing one endpoint's
 *  numbers is a maintenance trap, and worse, it invites a reader to take the
 *  second screen as independent corroboration of the first. It is the same row
 *  of the same response, printed twice.
 *
 *  DO NOT RE-ADD IT. The question it was defended as answering — "did the app
 *  I just registered actually sync?" — is answered better, and more honestly, by
 *  three fields already on every app card below: **Last successful sync**,
 *  **Lifetime sync completed** and **Registered**. Those NAME the watermark. A
 *  KPI tile only implies one, and for an unsynced app it implied the wrong one:
 *  `/kpi` answers HTTP 200 with `status: true`, every count and money figure and
 *  `trend` all `null`, `data_state: 'NEVER_SYNCED'` — which a page testing
 *  `resp.status && resp.data` rendered as eight em-dash tiles under "Last 30
 *  days" and a chart blaming "a gap in the response". Both were false: nothing
 *  had ever run for that app.
 *
 *  A one-sentence pointer to the Overview sits under the roster instead, so an
 *  operator who used to read the figures here knows where they went. Keep it a
 *  pointer. A "small" summary rebuilt here is this same duplication again.
 *
 *  ── READING IS EVERYONE'S; REGISTERING IS `apps:manage` ─────────────────────
 *  Every role holds `apps:read`, so every role sees the roster and can choose
 *  which app to report on (that choice is local to this browser). Registering an
 *  app writes to the install, so the form and the "Register another app" action
 *  are HIDDEN for a role without `apps:manage` — not disabled: there is nothing a
 *  reader without it can do with a form. The fresh-install empty state then says
 *  that an Owner or Admin has to register the app, rather than showing a form
 *  whose Save would answer 403.
 * =============================================================================
 */

/**
 * A timestamp with its time of day, or `—`.
 *
 *  `—`, never "never". A missing `last_synced_at` on an app row genuinely does mean no sync has
 * completed, but this helper is also handed values that are simply absent from an older document,
 * and the two must not render as the same confident negative. The caller supplies the meaning.
 *
 * @param {String|Date} value - An ISO string or Date.
 * @returns {String} Localised date and time, or the em dash.
 */
const _fmtWhen = (value) => {
    if (!value) {
        return '—';
    }
    try {
        return new Date(value).toLocaleString();
    } catch (e) {
        return String(value);
    }
};

/**
 * One label/value line inside an app's detail card.
 *
 * @param {Object} props
 * @param {String} props.label - What the value is.
 * @param {String} props.value - Already formatted. `—` when unknown.
 * @param {String} [props.hint] - Why it is unknown, or what it means. Rendered under the value.
 * @returns {JSX.Element}
 */
const FactRow = ({ label, value, hint }) => {
    let hintMarkup = null;
    if (hint) {
        hintMarkup = <Text as="span" variant="bodyXs" tone="subdued">{hint}</Text>;
    }
    return (
        <BlockStack gap="050">
            <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
            <Text as="span" variant="bodyMd" fontWeight="semibold">{value}</Text>
            {hintMarkup}
        </BlockStack>
    );
};

/**
 * The Partner Apps setup screen: register the configured app, choose which one the dashboard is
 * scoped to, and see what has actually been synced for it.
 *
 * Takes no props — the selection it reads and writes lives in `growthIntelContext`, shared with the
 * picker in the side nav, so choosing an app here changes every other page too.
 *
 * @returns {JSX.Element} The framed page.
 */
const PartnerAppsPage = () => {
    const { toastMarkup } = useContext(LoaderContext) || {};
    const { apps, appId, setAppId, selectedApp, appsLoading, appsState, appsError, hydrated, refreshApps } = useGrowthIntel();
    const session = useSession();
    const canManage = session.can(PERMISSIONS.APPS_MANAGE);
    const canOpenOverview = canViewPage(session.permissions, DASHBOARD_ROUTES.OVERVIEW);

    // Open on demand once at least one app exists; on a fresh install the form is always on screen
    // (see `showForm` below) because there is nothing else the operator could usefully do.
    const [addOpen, setAddOpen] = useState(false);
    // The app the LAST save actually registered. Held so the operator can see that the id the
    // backend was configured for is the one they got — the form cannot tell them, because it posted
    // a different field.
    const [justRegistered, setJustRegistered] = useState(null);

    /**
     * Runs after `PartnerAppForm` saves.
     *
     * ⚠️ Supplying this callback is not optional. Without it the form falls back to
     * `router.push('/apps/<app_id>')`, and there is no such route in this dashboard —
     * a successful registration would land the operator on a 404.
     *
     * Selects the app that was registered, re-reads the roster so the side-nav picker shows it, and
     * keeps the returned record so the identity banner can report which app the backend actually
     * registered.
     *
     * @param {Object} savedApp - The serialized app row from `POST /api/partner-apps`.
     * @returns {void}
     */
    const handleSaved = useCallback((savedApp) => {
        setAddOpen(false);
        if (savedApp && savedApp.app_id) {
            setAppId(savedApp.app_id);
        }
        if (savedApp) {
            setJustRegistered(savedApp);
        }
        refreshApps();
    }, [refreshApps, setAppId]);

    // ── Registration identity ────────────────────────────────────────────────────────────────
    // What the backend registered, in its own words. Shown after a save because the form posted an
    // app id that never reached the API, and an operator who typed one has no other way to learn
    // that the configured id is the one that took effect.
    let registeredBanner = null;
    if (justRegistered) {
        let registeredTone = 'success';
        let registeredTitle = 'Registered';
        if (!justRegistered.partner_api_app_id) {
            registeredTone = 'warning';
            registeredTitle = 'Registered, but the app row carries no Partner API id';
        }
        registeredBanner = (
            <Banner tone={registeredTone} title={registeredTitle} onDismiss={() => setJustRegistered(null)}>
                <p>
                    {`This install now reports on “${justRegistered.display_name}” (${justRegistered.partner_api_app_id || 'no Partner API id on the row'}). `}
                    That id came from the backend&apos;s <code>SHOPIFY_PARTNER_APP_ID</code>, not from the form.
                    If it is not the app you meant, change that variable, restart the backend, and register again.
                </p>
            </Banner>
        );
    }

    // ── The form, and the caveat that has to travel with it ──────────────────────────────────
    const configurationNotice = (
        <Banner tone="info" title="The app id comes from the backend, not from this form">
            <BlockStack gap="200">
                <p>
                    The Shopify Partner API cannot look an app up by name, handle or API key — <code>app(id:)</code> is
                    its only entry point — so there is nothing for this dashboard to discover an app from. The app this
                    install reports on is the one named by <code>SHOPIFY_PARTNER_APP_ID</code> in the backend&apos;s{' '}
                    <code>.env</code>: the number after <code>/apps/</code> in your Partner dashboard URL.
                </p>
                <p>
                    Saving below registers that app and stores the three display fields —{' '}
                    <b>Display name</b>, <b>App handle</b> and <b>App Store listing URL</b>. The form&apos;s{' '}
                    <b>Shopify Partner API App ID</b>, <b>Categories</b>, <b>Initial target keywords</b> and{' '}
                    <b>Active</b> fields are not stored <i>by this registration call</i>; the ID field is required by
                    the form, so paste the configured value into it to keep the two readings of the same fact in
                    agreement.
                </p>
                <p>
                    {/*  The qualifier matters: PATCH /api/partner-apps/:id DOES store categories,
                        target keywords and the active flag. Saying flatly that they "are not stored
                        by this backend" was true only of registration, and it would send an operator
                        looking for a feature that already exists. */}
                    <b>Categories</b>, <b>Initial target keywords</b> and <b>Active</b> are editable once the app
                    exists — they are written by the update endpoint, not by registration. The Partner API app id is
                    the one field that is never writable from here: it identifies which app every stored event and
                    payout belongs to, so changing it would re-label this install&apos;s whole history as another
                    app&apos;s.
                </p>
            </BlockStack>
        </Banner>
    );

    // ── App roster ───────────────────────────────────────────────────────────────────────────
    const appCards = apps.map((app) => {
        const isSelected = app.app_id === appId;

        let selectedBadge = null;
        if (isSelected) {
            selectedBadge = <Badge tone="success">Selected</Badge>;
        }

        let activeBadge = <Badge tone="critical">Inactive</Badge>;
        if (app.is_active) {
            activeBadge = <Badge>Active</Badge>;
        }

        //  `last_synced_at` is stamped only by a fully successful Partner API sync (both halves
        // written AND coverage re-measured), so its absence is a real "no sync has ever completed"
        // rather than a missing field — which is why this one may say so in words.
        let syncedValue = '—';
        let syncedHint = 'No Partner API sync has completed for this app yet, so every figure in the Performance suite reads as unavailable.';
        if (app.last_synced_at) {
            syncedValue = _fmtWhen(app.last_synced_at);
            syncedHint = 'End of the last window a fully successful sync covered.';
        }

        let lifetimeValue = '—';
        let lifetimeHint = 'No lifetime sync has completed, so every all-time total is a FLOOR — whatever incremental windows happened to pull — not a total.';
        if (app.lifetime_sync_completed_at) {
            lifetimeValue = _fmtWhen(app.lifetime_sync_completed_at);
            lifetimeHint = 'All-time totals are totals, not floors.';
        }

        let listingMarkup = <Text as="span" variant="bodyMd" fontWeight="semibold">—</Text>;
        if (app.listing_url) {
            listingMarkup = <Link url={app.listing_url} target="_blank" removeUnderline>{app.listing_url}</Link>;
        }

        let selectButton = (
            <Button onClick={() => setAppId(app.app_id)}>Report on this app</Button>
        );
        if (isSelected) {
            selectButton = <Button disabled>Currently selected</Button>;
        }

        return (
            <Card key={app.app_id}>
                <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="start" gap="400" wrap>
                        <BlockStack gap="100">
                            <InlineStack gap="200" blockAlign="center" wrap>
                                <Text as="h3" variant="headingMd">{app.display_name}</Text>
                                {selectedBadge}
                                {activeBadge}
                            </InlineStack>
                            <Text as="span" variant="bodySm" tone="subdued">
                                {`Handle: ${app.app_handle || '—'} · Partner API id: ${app.partner_api_app_id || '—'}`}
                            </Text>
                        </BlockStack>
                        {/* InlineStack, not the surrounding BlockStack: a Button dropped straight
                            into a BlockStack stretches to the full card width. */}
                        <InlineStack>{selectButton}</InlineStack>
                    </InlineStack>

                    <Divider />

                    <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
                        <FactRow label="Last successful sync" value={syncedValue} hint={syncedHint} />
                        <FactRow label="Lifetime sync completed" value={lifetimeValue} hint={lifetimeHint} />
                        <FactRow label="Registered" value={_fmtWhen(app.createdAt)} />
                        <BlockStack gap="050">
                            <Text as="span" variant="bodySm" tone="subdued">App Store listing</Text>
                            {listingMarkup}
                        </BlockStack>
                    </InlineGrid>
                </BlockStack>
            </Card>
        );
    });

    // ── Where the install and revenue figures went ───────────────────────────────────────────
    // A FORWARDING ADDRESS, NOT A SUMMARY — see the file header. The KPI tiles, the caveat card
    // and the install-activity chart were rendered here from the same `/kpi` read the Overview
    // performs, and were removed because one endpoint's numbers on two screens read as two
    // confirmations of one fact. This sentence exists so an operator who used to read them here is
    // not left hunting; it deliberately quotes NO figure, because a figure quoted here is the
    // duplication starting over.
    //
    // It carries no data state of its own on purpose: it makes no claim about the app, so there is
    // nothing for it to be wrong about. The sync answer this screen owes the reader is the three
    // timestamps on each card above — they name the watermark rather than implying it.
    //
    // Only for a role that can open the Overview: a link onto "Restricted" forwards nobody anywhere.
    let overviewPointer = null;
    if (canOpenOverview) {
        overviewPointer = (
            <Text as="p" variant="bodySm" tone="subdued">
                Installs, trials, subscriptions and revenue for the selected app are on the{' '}
                <Link url={DASHBOARD_ROUTES.OVERVIEW} removeUnderline>Overview</Link>. The sync
                timestamps on each card above are this page&apos;s own answer to whether an app has
                synced yet.
            </Text>
        );
    }

    // ── Page body ────────────────────────────────────────────────────────────────────────────
    // FIVE states now, not three, and the two that were added are the two that were being ANSWERED
    // WITH THE EMPTY ONE — see the file header for why the empty state is the design here.
    //
    // "REGISTER YOUR SHOPIFY APP TO BEGIN" IS A CLAIM ABOUT THE OPERATOR'S ACCOUNT, and on this
    // page it is the loudest one in the build: a headingLg over a registration form, shown to
    // somebody who may well have registered an app months ago. It reached the screen after any
    // failed roster request, because `appsLoading` goes false when a request FAILS just as it does
    // when one succeeds, and `apps` is `[]` from the initial state on a first load — so keeping the
    // last measured roster (the provider's other fix) cannot rescue this path either. Only
    // `appsState === READY` licenses the sentence.
    let body = null;

    if (!hydrated || appsLoading || appsState === APPS_STATE.PENDING) {
        body = <Card><Text as="p">Reading the registered partner apps…</Text></Card>;
    }

    // Rendered ABOVE the body rather than instead of it. A failed REFRESH still leaves the roster
    // we measured earlier on screen — stale beats absent, and the banner is what says it is stale —
    // while a failed FIRST load has `apps: []` and no body at all, which is correct: what is on the
    // account is unknown until this call succeeds.
    let rosterErrorBanner = null;
    if (appsState === APPS_STATE.ERROR) {
        rosterErrorBanner = (
            <Banner
                tone="critical"
                title="The partner app list could not be loaded"
                action={{ content: 'Try again', onAction: refreshApps }}
            >
                <p>{appsError}</p>
                {apps.length === 0 ? (
                    <p>
                        Whether any app is registered is unknown until this call succeeds, so the
                        registration form is deliberately not offered below — filling it in could
                        create a second copy of an app that already exists.
                    </p>
                ) : (
                    <p>The apps listed below are the last roster this dashboard successfully read.</p>
                )}
            </Banner>
        );
    }

    // UNAUTHENTICATED leaves `body` null on purpose: the axios interceptor has already begun the
    // redirect to /login, and a page that draws anything at all during it reads as a live screen.

    if (hydrated && appsState === APPS_STATE.READY && apps.length === 0 && !canManage) {
        // A measured empty roster, and a role that cannot fill it. Same READY gate as the branch below
        // — this is still a claim about the account — but the next step is a person, not a form.
        let roleLabel = 'your role';
        if (session.role && session.role.label) {
            roleLabel = session.role.label;
        }
        body = (
            <Card>
                <BlockStack gap="300">
                    <Text as="h2" variant="headingLg">No partner app is registered yet</Text>
                    <Text as="p" variant="bodyMd">
                        This dashboard reports on one Shopify Partner app at a time, and nothing else in it can load
                        until an app is registered.
                    </Text>
                    <Text as="p" variant="bodyMd" tone="subdued">
                        {`Registering one needs ${permissionLabel(PERMISSIONS.APPS_MANAGE)}, which the ${roleLabel} role does not include. Ask an Owner or Admin to register the app; it will appear here as soon as they have.`}
                    </Text>
                </BlockStack>
            </Card>
        );
    }

    if (hydrated && appsState === APPS_STATE.READY && apps.length === 0 && canManage) {
        body = (
            <BlockStack gap="400">
                <Card>
                    <BlockStack gap="300">
                        <Text as="h2" variant="headingLg">Register your Shopify app to begin</Text>
                        <Text as="p" variant="bodyMd">
                            This dashboard reports on one Shopify Partner app at a time. Nothing else in it can load
                            until an app is registered: every figure — installs, trials, subscriptions, revenue — is
                            read out of the Partner API history for a single app id, and there is no default.
                        </Text>
                        <Text as="p" variant="bodyMd" tone="subdued">
                            Registering takes one save. After that, run the first Partner API sync from the Sync page;
                            until that sync completes, every Performance page will correctly report that it has no data
                            rather than showing you zeroes.
                        </Text>
                    </BlockStack>
                </Card>
                {configurationNotice}
                <PartnerAppForm mode="create" onSaved={handleSaved} />
            </BlockStack>
        );
    }

    if (hydrated && apps.length > 0) {
        let addSection = null;
        if (addOpen && canManage) {
            // ⚠️ The form's own Cancel button pushes to `/apps` — which IS this route,
            // so Next re-renders without remounting and `addOpen` survives: from the operator's
            // side, Cancel appears to do nothing. This header row is the working way out, and it
            // lives here rather than as an edit to the shared component.
            addSection = (
                <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center" gap="400" wrap>
                        <Text as="h2" variant="headingMd">Register another app</Text>
                        <InlineStack>
                            <Button onClick={() => setAddOpen(false)}>Close</Button>
                        </InlineStack>
                    </InlineStack>
                    {configurationNotice}
                    <PartnerAppForm mode="create" onSaved={handleSaved} />
                </BlockStack>
            );
        }

        let selectionNote = null;
        if (!selectedApp) {
            selectionNote = (
                <Banner tone="warning" title="No app is selected">
                    <p>
                        Pick one below, or from the picker in the side nav. Every other page is scoped by this
                        selection and will report no data until it is made.
                    </p>
                </Banner>
            );
        }

        body = (
            <BlockStack gap="400">
                {selectionNote}
                <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">{`Registered apps (${apps.length})`}</Text>
                    {appCards}
                    {overviewPointer}
                </BlockStack>
                {addSection}
            </BlockStack>
        );
    }

    // Only offered once an app exists: on a fresh install the form is already on screen, and a
    // button that opens what is already open reads as a broken control.
    let primaryAction = null;
    if (hydrated && apps.length > 0 && !addOpen && canManage) {
        primaryAction = <Button variant="primary" onClick={() => setAddOpen(true)}>Register another app</Button>;
    }

    return (
        <SideNavBar>
            <Page
                title="Partner Apps"
                subtitle="The Shopify app this install reports on. Everything else is scoped by the selection made here."
                fullWidth
                backAction={canOpenOverview ? { content: 'Growth Intelligence', url: DASHBOARD_ROUTES.OVERVIEW } : undefined}
                primaryAction={primaryAction}
            >
                <BlockStack gap="400">
                    {registeredBanner}
                    {rosterErrorBanner}
                    {body}
                    <Box paddingBlockEnd="400" />
                </BlockStack>
            </Page>
            {toastMarkup}
        </SideNavBar>
    );
};

export default PartnerAppsPage;
