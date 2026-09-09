import Document, { Html, Head, Main, NextScript } from 'next/document';

/**
 * The HTML shell.
 *
 * Deliberately almost empty: this is a self-hosted internal dashboard, so there
 * is no Open Graph card to render, nothing to share, and nobody to share it with.
 * The one meta tag that matters is `noindex, nofollow` — an instance exposed on a
 * public hostname should not end up in a search index, and a robots directive is
 * the cheap half of not letting that happen (authentication is the other half).
 */
class MyDocument extends Document {
    render() {
        return (
            <Html lang="en">
                <Head>
                    <meta name="robots" content="noindex, nofollow" />
                    <meta name="referrer" content="same-origin" />
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
