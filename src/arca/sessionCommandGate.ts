export type SessionCommandLease = () => void;

/**
 * Impide que dos solicitudes HTTP usen la misma página Playwright a la vez.
 * La exclusión vive en el proceso del worker y se libera siempre en `finally`.
 */
export class SessionCommandGate {
  private active = false;

  tryAcquire(): SessionCommandLease | undefined {
    if (this.active) return undefined;
    this.active = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = false;
    };
  }
}
