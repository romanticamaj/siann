// The position display's primary format for the chrome that words positions
// outside the display (UI redesign spec 7 P1-5: plan wording follows the
// primary format once m5-ui-transport lands it). App provides the layout
// store's value; without a provider it is Bars+Beats, the default.

import { createContext } from 'react';

import type { TimeFormat } from '../timeline/transport-time';

export const TimeFormatContext = createContext<TimeFormat>('bars');
