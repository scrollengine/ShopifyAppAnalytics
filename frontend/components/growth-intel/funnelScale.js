/**
 * Pure geometry for the Partner-style funnel chart.
 *
 * Kept out of the component (and free of JSX) so the log-scale maths — which
 * has to survive zero counts, counts of exactly 1, and a single-step funnel —
 * can be unit-tested directly.
 */

export const PLOT_HEIGHT = 300;
export const AXIS_LEFT = 46;
export const AXIS_RIGHT = 12;
export const TOP_PAD = 26;
export const BASE_PAD = 10;
export const MAX_BAR_WIDTH = 58;

/**
 * Log-scale ticks as powers of ten covering the largest value, so the axis
 * reads 1 / 10 / 100 / 1K like the Partner dashboard.
 *
 * @param {Number} maxCount - Largest step count in the funnel.
 * @returns {{ticks: Array<Number>, maxTick: Number}}
 */
export const buildScale = (maxCount) => {
    const safeMax = Number.isFinite(maxCount) && maxCount > 0 ? maxCount : 1;
    let exponent = 1;
    if (safeMax > 1) {
        exponent = Math.ceil(Math.log10(safeMax));
    }
    if (exponent < 1) {
        exponent = 1;
    }
    const ticks = [];
    for (let i = 0; i <= exponent; i += 1) {
        ticks.push(Math.pow(10, i));
    }
    return { ticks, maxTick: Math.pow(10, exponent) };
};

/**
 * Full bar/label geometry for the plot area.
 *
 * @param {Object} params
 * @param {Array<Object>} params.steps - Funnel steps from the API (need `count`).
 * @param {Number} params.width - Measured pixel width of the chart container.
 * @returns {Object} bars, ticks, yFor, baseline, barWidth, slot.
 */
export const buildGeometry = ({ steps, width }) => {
    const list = Array.isArray(steps) ? steps : [];
    const maxCount = list.reduce((m, s) => Math.max(m, (s && s.count) || 0), 0);
    const { ticks, maxTick } = buildScale(maxCount);

    const plotWidth = Math.max(width - AXIS_LEFT - AXIS_RIGHT, 120);
    const baseline = PLOT_HEIGHT - BASE_PAD;
    const usableHeight = baseline - TOP_PAD;
    const logMax = Math.log10(maxTick);

    // A log axis has no room for 0, and 1 sits exactly on the baseline. Both
    // clamp to the baseline rather than producing -Infinity.
    const yFor = (value) => {
        if (!Number.isFinite(value) || value <= 1) {
            return baseline;
        }
        const ratio = Math.log10(value) / logMax;
        return baseline - (ratio * usableHeight);
    };

    const slot = plotWidth / Math.max(list.length, 1);
    const barWidth = Math.min(slot * 0.34, MAX_BAR_WIDTH);

    const bars = list.map((step, i) => {
        const centre = AXIS_LEFT + (slot * i) + (slot / 2);
        const top = yFor(step.count);
        let height = baseline - top;
        if (height < 2 && step.count > 0) {
            height = 2;
        }
        if (step.count <= 0) {
            height = 0;
        }
        return {
            step,
            x: centre - (barWidth / 2),
            centre,
            top,
            height,
            slotStart: AXIS_LEFT + (slot * i),
            slotEnd: AXIS_LEFT + (slot * (i + 1))
        };
    });

    return { bars, ticks, yFor, baseline, barWidth, plotWidth, slot };
};
