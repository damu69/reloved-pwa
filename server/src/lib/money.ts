// Every amount in the API is an integer number of paise in Indian rupees (₹1 = 100 paise).
// Prices include GST. Responses carry `currency` so clients never have to assume it.
export const CURRENCY = "INR" as const;
