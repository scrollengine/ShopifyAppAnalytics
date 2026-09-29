import { useState } from 'react';
import { TextField } from '@shopify/polaris';

/**
 * The password policy, in the words every new-password field shows.
 *
 * ⚠️ THE RULE ITSELF IS ENFORCED BY THE BACKEND, NOT HERE (NFC-normalised, at least 15 code points,
 * at most 72 UTF-8 bytes, a blocklist, no composition rules — NIST SP 800-63B). The only client-side
 * check is that the two fields match. Counting characters here would disagree with the server the
 * first time someone types an emoji (JS `length` counts UTF-16 units, not code points), and a form
 * that says "OK" and then gets refused is worse than one that simply asks the server.
 */
export const PASSWORD_POLICY_HINT = 'At least 15 characters. Long passphrases are welcome; there are no character-type rules.';

/**
 * NFC-normalises when the runtime can, so a password typed with composed and decomposed accents in
 * the two fields compares the way the server will compare it.
 *
 * @param {String} value - A password.
 * @returns {String} The normalised password.
 */
const _nfc = (value) => {
    if (typeof value.normalize === 'function') {
        return value.normalize('NFC');
    }
    return value;
};

/**
 * What is wrong with a new-password pair, from the form alone.
 *
 * @param {String} password - The new password.
 * @param {String} confirm - The same, typed again.
 * @returns {String} A message to show, or '' when the pair can be sent.
 */
export const passwordPairError = (password, confirm) => {
    if (!password) {
        return 'Enter a new password.';
    }
    if (!confirm) {
        return 'Enter the password again to confirm it.';
    }
    if (_nfc(password) !== _nfc(confirm)) {
        return 'The two passwords do not match.';
    }
    return '';
};

/**
 * A new password and its confirmation.
 *
 * `autoComplete="new-password"` on both, so a password manager offers to generate one and saves it
 * against the email the page shows (pages that know the email render it in a read-only
 * `autoComplete="username"` field for exactly that reason).
 *
 * The mismatch message appears once the confirm field has been left, or once the parent says a
 * submit was attempted — not on every keystroke, where the first character of a correct confirmation
 * would already read as an error.
 *
 * @param {Object} props - Component props.
 * @param {String} props.password - Controlled value of the new password.
 * @param {String} props.confirm - Controlled value of the confirmation.
 * @param {Function} props.onPasswordChange - Receives the new password.
 * @param {Function} props.onConfirmChange - Receives the new confirmation.
 * @param {Boolean} [props.disabled] - Disables both fields while a request is in flight.
 * @param {Boolean} [props.showMismatch] - True once a submit was attempted.
 * @param {String} [props.label] - Label of the first field.
 * @param {String} [props.confirmLabel] - Label of the second field.
 * @returns {JSX.Element} The two fields.
 */
function PasswordFields({ password, confirm, onPasswordChange, onConfirmChange, disabled, showMismatch, label, confirmLabel }) {
    const [confirmBlurred, setConfirmBlurred] = useState(false);

    let confirmError;
    if ((confirmBlurred || showMismatch) && confirm && _nfc(password) !== _nfc(confirm)) {
        confirmError = 'The two passwords do not match.';
    }

    return (
        <>
            <TextField
                label={label || 'New password'}
                type="password"
                value={password}
                onChange={onPasswordChange}
                autoComplete="new-password"
                helpText={PASSWORD_POLICY_HINT}
                disabled={disabled}
            />
            <TextField
                label={confirmLabel || 'Confirm new password'}
                type="password"
                value={confirm}
                onChange={onConfirmChange}
                onBlur={() => setConfirmBlurred(true)}
                autoComplete="new-password"
                error={confirmError}
                disabled={disabled}
            />
        </>
    );
}

export default PasswordFields;
