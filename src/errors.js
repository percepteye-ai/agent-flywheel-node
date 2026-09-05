/**
 * The two failures a caller must be able to tell apart.
 *
 * `LeaseLost` is not an error in the operational sense -- it is the control
 * plane saying "this rollout is no longer yours", which happens whenever a
 * lease lapses and the work is requeued. A caller that treats it as a
 * transport failure retries forever against a rollout someone else now owns.
 */
export class TransportError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "TransportError";
  }
}

export class LeaseLost extends TransportError {
  constructor(message, options) {
    super(message, options);
    this.name = "LeaseLost";
  }
}

/**
 * A setting this package refuses to guess at.
 *
 * Raised for an unrecognised `PERCEPTEYE_AGENT_MODE`, and only there. The
 * alternative -- defaulting a typo to `training` -- keeps a process
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
