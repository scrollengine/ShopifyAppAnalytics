/**
 * Input and result shapes for `partner/clients/partnerApi.client`.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 * ⚠️ The client is READ-ONLY by construction. Nothing here describes a mutation, and nothing here
 * should: a document carrying one is rejected before the HTTP call leaves the process, so a type
 * that made a mutation expressible would only be describing a request that can never be sent.
 */

/** A GraphQL variables bag as it goes onto the wire. Values are whatever the document declares. */
export type PartnerGraphQlVariables = Record<string, any>;

/** One GraphQL call. */
export interface PartnerRunQueryInput {
    /** The GraphQL document. Rejected before dispatch if it contains a mutation operation. */
    query: string;
    variables?: PartnerGraphQlVariables;
}

/** One auto-paginated cursor walk over a GraphQL connection. */
export interface PartnerFetchAllPagesInput {
    /** MUST accept `$first: Int!` and `$after: String`. */
    query: string;
    /** Everything except `after`, which the paginator manages. */
    variables?: PartnerGraphQlVariables;
    /** Dot path to the connection inside `data`, e.g. "app.events" or "transactions". */
    connectionPath: string;
    pageSize?: number;
    maxPages?: number;
}

/**
 * What a pagination run collected.
 *
 * ⚠️ This shape is returned on FAILURE too, with `status: false`. `partial` and `truncated` are the
 * two ways a caller learns the node list is incomplete — advancing a sync watermark on either one
 * skips data that was never fetched, and the skipped window is then invisible forever because the
 * next run starts after it.
 */
export interface PartnerPageResult {
    /** Every `edge.node` across every page walked, flattened in page order. */
    nodes: any[];
    pages_fetched: number;
    /** Hit the `maxPages` ceiling while the connection still reported more data. */
    truncated: boolean;
    /** A page failed mid-run; the nodes already collected are still returned. */
    partial: boolean;
    /** Cursor of the last fully-consumed page, so a caller can resume rather than restart. */
    resume_cursor: string | null;
}

/**
 * The subset of a rejected HTTP call this client reads.
 *
 * `catch` binds `unknown`, and every field below is optional, so each access stays guarded exactly
 * as the original `error && error.response && error.response.status` chain was. Deliberately not
 * axios's own `AxiosError`: the value in a `catch` is whatever was thrown, which is not necessarily
 * an axios error at all.
 */
export interface PartnerApiHttpError {
    message?: string;
    response?: {
        status?: number;
        /** Response headers, lower-cased by axios but read both ways for `Retry-After`. */
        headers?: Record<string, any>;
        /** The response body. A GraphQL error payload when the Partner API answered at all. */
        data?: any;
    };
}
