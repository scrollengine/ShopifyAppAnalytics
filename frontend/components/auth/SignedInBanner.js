import { useEffect, useState } from 'react';
import { Banner } from '@shopify/polaris';

import { hasAuthToken } from '../../utils/auth';

/**
 * Says so when this browser already holds a dashboard session on a token page.
 *
 * The common case is an admin opening an invitation link to check it, or someone resetting a password
 * in the browser they are signed in with. Finishing the flow clears that session token here (the page
 * calls `clearAuthToken()` before going to /login), so the person is told BEFORE they press the
 * button rather than discovering they were signed out.
 *
 * Read in an effect: `localStorage` does not exist during server rendering, and the first client paint
 * must match it.
 *
 * @param {Object} props - Component props.
 * @param {String} props.children - What finishing this flow does to the session, in this flow's words.
 * @returns {JSX.Element|null} The banner, or nothing when no session token is stored.
 */
function SignedInBanner({ children }) {
    const [present, setPresent] = useState(false);

    useEffect(() => {
        setPresent(hasAuthToken());
    }, []);

    if (!present) {
        return null;
    }
    return (
        <Banner tone="info" title="This browser is signed in to the dashboard">
            <p>{children}</p>
        </Banner>
    );
}

export default SignedInBanner;
