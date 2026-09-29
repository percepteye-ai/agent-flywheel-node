/**
 * The two failures a caller must be able to tell apart.
 *
 * `LeaseLost` is not an error in the operational sense -- it is the control
 * plane saying "this rollout is no longer yours", which happens whenever a
 * lease lapses and the work is requeued. A caller that treats it as a
 * transport failure retries forever against a rollout someone else now owns.
 */
export class TransportError extends Error {
  /**
   * `statusCode` is the HTTP status the control plane answered with, or `null`
   * when no response was ever produced.
   *
   * IT HAD TO BECOME A PROPERTY. It was only ever in the message string, so
   * the one caller that has to tell a 422 ("resending these bytes will be
   * refused forever") from a 503 ("try again in a moment") could do it by
   * parsing English or not at all. `outbox.js:retirementFor` is that caller,
   * and it reads this. `null` is the TRANSIENT side of the split on purpose: a
   * network blip that retired a rollout's only copy of its result would be a
   * worse failure than the one the split exists to handle. Python's half of
   * this contract spells it `status_code`.
   *
   * `ambiguous` is true when the control plane MAY HAVE PERFORMED the request
   * although this error was thrown: some attempt failed after the request
   * could have reached it -- a timeout, a dropped connection, a 5xx other
   * than 503 -- or it answered 2xx with a body that could not be read. False
   * means no attempt can have been performed: each was never sent, or was
   * refused (a 4xx, or a 503 saying it was not handled). Only the client
   * knows, because only it saw every attempt; a caller about to tell someone
   * "that did not happen" asks this. Python spells it `ambiguous` too.
   */
  constructor(message, options) {
    super(message, options);
    this.name = "TransportError";
    this.statusCode = options?.statusCode ?? null;
    this.ambiguous = options?.ambiguous === true;
  }
}

export class LeaseLost extends TransportError {
  constructor(message, options) {
    super(message, options);
    this.name = "LeaseLost";
    // A lease is lost by exactly one status, and a caller that reads the code
    // must see it here too rather than only on the subclass's name.
    this.statusCode = options?.statusCode ?? 410;
  }
}

/**
 * A setting this package refuses to guess at.
 *
 * The original and still the clearest case is an unrecognised
 * `PERCEPTEYE_AGENT_MODE`. It is not the only one: `config.js`, `rollout.js`
 * and `execution-identity.js` each refuse a setting they must not guess at.
 * This line used to read "and only there", which stopped being true the first
 * time one of those was added.
 *
 * For the mode, the alternative -- defaulting a typo to `training` -- keeps a
 * process
 * contributing rollouts on a customer's credentials after an operator
 * believed they had switched it off, with nothing printed anywhere. There is
 * no safe guess for a mode, so a bad one is a startup failure.
 */
export class ConfigurationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ConfigurationError";
  }
}
