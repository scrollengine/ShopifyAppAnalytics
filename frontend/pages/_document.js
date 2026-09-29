import Document, { Html, Head, Main, NextScript } from 'next/document';

/**
 * The HTML shell.
 *
 * Deliberately almost empty: this is a self-hosted internal dashboard, so there
 * is no Open Graph card to render, nothing to share, and nobody to share it with.
 * Two meta tags matter:
 *
 *  - `robots: noindex, nofollow` — an instance exposed on a public hostname should
 *    not end up in a search index, and a robots directive is the cheap half of not
 *    letting that happen (authentication is the other half).
 *
 *  - `referrer: no-referrer` — ⚠️ THIS META OVERRIDES THE HEADER. next.config.js
 *    already sends `Referrer-Policy: no-referrer`, but a `<meta name="referrer">`
 *    wins over the header for the document it is in, and this one used to say
 *    `same-origin`. That sent the full URL of the page in the Referer of every
 *    same-origin request — including the `/api/*` calls the invite, setup and
 *    password-reset pages make while their emailed link is still in the address
 *    bar. The token rides in the fragment (never sent in a Referer) and is
 *    stripped on load, so this is the second lock, not the only one.
 */
class MyDocument extends Document {
    render() {
        return (
            <Html lang="en">
                <Head>
                    <meta name="robots" content="noindex, nofollow" />
                    <meta name="referrer" content="no-referrer" />
                </Head>
                <body>
                    <Main />
                    <NextScript />
                </body>
            </Html>
        );
    }
}

export default MyDocument;
