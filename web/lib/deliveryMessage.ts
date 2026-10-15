/** The message a seller signs to see their buyers' addresses. It names the drop and the time, so it cannot be reused later. */
export const viewMessage = (promo: string, at: number) => `Tifo: show the delivery details for drop ${promo.toLowerCase()} (${at})`;
