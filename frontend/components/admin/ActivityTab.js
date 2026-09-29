import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Banner,
    BlockStack,
    Box,
    Button,
    Card,
    EmptyState,
    IndexTable,
    InlineStack,
    SkeletonBodyText,
    Text
} from '@shopify/polaris';

import UserAdminApiService from '../../API_Services/userAdminService';
import { auditActionLabel } from '../../utils/permissions';
import useAdminSession from './useAdminSession';
import LoadFailureBanner from './LoadFailureBanner';
import {
    DASH,
    auditActorLabel,
    auditEventId,
    auditEventTime,
    auditTargetLabel,
    failureMessage,
    formatDateTime,
    summariseAuditDetails
} from './adminPresentation';

const API = new UserAdminApiService();

/** Rows per request. The server clamps to 1..200. */
const PAGE_SIZE = 50;

/**
 * The Activity tab: the security log, newest first, paged with the server's cursor.
 *
 * The page renders this tab only for `audit:read`; the server enforces the same key.
 *
 * ⚠️ PAGES ARE APPENDED BY CURSOR, NEVER BY OFFSET. Events keep arriving while someone reads, so
 * "page 2" by offset would repeat rows that slid down. `next_before` names the last row returned,
 * and rows are still de-duplicated by id in case the server's boundary includes one twice.
 *
 * @returns {JSX.Element}
 */
const ActivityTab = () => {
    const { noteForbidden } = useAdminSession();

    // `items` stays null until the first page has actually been received.
    const [items, setItems] = useState(null);
    const [nextBefore, setNextBefore] = useState(null);
    const [state, setState] = useState('loading');
    const [failure, setFailure] = useState(null);
    const [moreFailure, setMoreFailure] = useState('');

    const mountedRef = useRef(true);
    const seqRef = useRef(0);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const loadFirstPage = useCallback(() => {
        seqRef.current += 1;
        const seq = seqRef.current;
        setState('loading');
        setFailure(null);
        setMoreFailure('');
        API.listAuditEvents({ limit: PAGE_SIZE }).then((result) => {
            if (!mountedRef.current || seq !== seqRef.current) {
                return;
            }
            if (result.status && Array.isArray(result.data.items)) {
                setItems(result.data.items);
                setNextBefore(typeof result.data.next_before === 'string' && result.data.next_before ? result.data.next_before : null);
                setState('ready');
                return;
            }
            noteForbidden(result);
            let reason = result;
            if (result.status) {
                reason = { status: false, msg: 'The server answered without an event list.', error: {}, http_status: result.http_status };
            }
            setItems(null);
            setNextBefore(null);
            setFailure(reason);
            setState('error');
        });
    }, [noteForbidden]);

    useEffect(() => {
        loadFirstPage();
    }, [loadFirstPage]);

    const loadMore = useCallback(() => {
        if (!nextBefore || state === 'loading_more') {
            return;
        }
        seqRef.current += 1;
        const seq = seqRef.current;
        setState('loading_more');
        setMoreFailure('');
        API.listAuditEvents({ limit: PAGE_SIZE, before: nextBefore }).then((result) => {
            if (!mountedRef.current || seq !== seqRef.current) {
                return;
            }
            if (result.status && Array.isArray(result.data.items)) {
                setItems((prev) => {
                    const current = Array.isArray(prev) ? prev : [];
                    const seen = new Set(current.map(auditEventId).filter(Boolean));
                    const fresh = result.data.items.filter((event) => {
                        const id = auditEventId(event);
                        return !id || !seen.has(id);
                    });
                    return current.concat(fresh);
                });
                setNextBefore(typeof result.data.next_before === 'string' && result.data.next_before ? result.data.next_before : null);
                setState('ready');
                return;
            }
            noteForbidden(result);
            // The rows already on screen stay: they were read successfully. Only the next page failed.
            setMoreFailure(failureMessage(result, 'The next page of events could not be loaded.'));
            setState('ready');
        });
    }, [nextBefore, state, noteForbidden]);

    const renderRow = (event, index) => {
        const id = auditEventId(event) || `event-${index}`;
        const details = summariseAuditDetails(event);
        return (
            <IndexTable.Row id={id} key={id} position={index}>
                <IndexTable.Cell>
                    <Text as="span" variant="bodySm">{formatDateTime(auditEventTime(event))}</Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                    <Text as="span" variant="bodyMd" fontWeight="semibold">{auditActionLabel(event.action)}</Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                    <Text as="span" variant="bodySm">{auditActorLabel(event)}</Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                    <Text as="span" variant="bodySm">{auditTargetLabel(event)}</Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                    {details.length > 0 ? (
                        <BlockStack gap="050">
                            {details.map((line) => <Text as="span" variant="bodyXs" key={line}>{line}</Text>)}
                        </BlockStack>
                    ) : <Text as="span" variant="bodySm" tone="subdued">{DASH}</Text>}
                </IndexTable.Cell>
                <IndexTable.Cell>
                    <Text as="span" variant="bodyXs" tone="subdued">{event.ip || DASH}</Text>
                </IndexTable.Cell>
            </IndexTable.Row>
        );
    };

    let tableMarkup = null;
    if (items === null && state === 'loading') {
        tableMarkup = (
            <Card>
                <SkeletonBodyText lines={6} />
            </Card>
        );
    } else if (items !== null) {
        let footer = null;
        if (nextBefore) {
            footer = (
                <Button onClick={loadMore} loading={state === 'loading_more'}>Load more</Button>
            );
        } else if (items.length > 0) {
            footer = <Text as="span" variant="bodySm" tone="subdued">End of the activity log.</Text>;
        }
        tableMarkup = (
            <Card padding="0">
                <IndexTable
                    resourceName={{ singular: 'event', plural: 'events' }}
                    itemCount={items.length}
                    selectable={false}
                    loading={state === 'loading'}
                    headings={[
                        { title: 'Time' },
                        { title: 'Action' },
                        { title: 'Actor' },
                        { title: 'Target' },
                        { title: 'Details' },
                        { title: 'IP' }
                    ]}
                    emptyState={(
                        <EmptyState heading="No activity recorded" image="">
                            <p>The security log holds no events.</p>
                        </EmptyState>
                    )}
                >
                    {items.map(renderRow)}
                </IndexTable>
                {footer ? (
                    <Box padding="400" borderBlockStartWidth="025" borderColor="border">
                        <InlineStack align="center">{footer}</InlineStack>
                    </Box>
                ) : null}
            </Card>
        );
    }

    return (
        <BlockStack gap="400">
            <Text as="p" tone="subdued">
                {'Times are shown in your browser\'s time zone. Events from anonymous visitors (setup and password-reset requests) are kept for 180 days; all other events are kept indefinitely.'}
            </Text>

            {state === 'error' ? (
                <LoadFailureBanner result={failure} what="The activity log" onRetry={loadFirstPage} />
            ) : null}

            {moreFailure ? (
                <Banner tone="critical" title="More events could not be loaded" onDismiss={() => setMoreFailure('')}>
                    <p>{moreFailure}</p>
                </Banner>
            ) : null}

            {tableMarkup}
        </BlockStack>
    );
};

export default ActivityTab;
