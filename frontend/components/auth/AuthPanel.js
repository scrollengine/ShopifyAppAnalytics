import { BlockStack, Box, Card, InlineStack, Spinner, Text } from '@shopify/polaris';

/**
 * The layout every public page shares: one centred card, no nav, no Frame.
 *
 * ⚠️ NO SideNavBar AND NO TOAST, ON PURPOSE. These pages are reached without a
 * session, so there is no nav to show and nothing it could link to; and a Polaris
 * Toast must sit inside a Frame, which only the nav provides. Every message on these
 * pages is an inline Banner inside the card — which is also where a person reading
 * "your link has expired" needs it to stay, rather than vanishing after 1.5 s.
 *
 * The two CSS classes are the sign-in screen's (`styles/globals.css`).
 *
 * @param {Object} props - Component props.
 * @param {String} props.title - The page heading.
 * @param {React.ReactNode} [props.subtitle] - One line under the heading.
 * @param {React.ReactNode} props.children - The body: banners, the form.
 * @param {React.ReactNode} [props.footer] - Small print under the body.
 * @returns {JSX.Element} The panel.
 */
function AuthPanel({ title, subtitle, children, footer }) {
    let subtitleMarkup = null;
    if (subtitle) {
        subtitleMarkup = <Text as="p" tone="subdued">{subtitle}</Text>;
    }

    let footerMarkup = null;
    if (footer) {
        footerMarkup = <Box paddingBlockStart="200">{footer}</Box>;
    }

    return (
        <div className="login-viewport">
            <div className="login-panel">
                <Card>
                    <BlockStack gap="500">
                        <BlockStack gap="100">
                            <Text as="h1" variant="headingLg">{title}</Text>
                            {subtitleMarkup}
                        </BlockStack>

                        {children}

                        {footerMarkup}
                    </BlockStack>
                </Card>
            </div>
        </div>
    );
}

/**
 * A spinner with one line of text, for the moment a page is reading its link or asking the server.
 *
 * @param {Object} props - Component props.
 * @param {String} props.label - What is happening, e.g. "Checking your link…".
 * @returns {JSX.Element} The loading row.
 */
export function AuthPanelLoading({ label }) {
    return (
        <InlineStack gap="200" blockAlign="center">
            <Spinner size="small" accessibilityLabel={label} />
            <Text as="p" tone="subdued">{label}</Text>
        </InlineStack>
    );
}

export default AuthPanel;
