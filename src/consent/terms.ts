/**
 * KAN-27 (SYS-02): the informed-consent terms a user must accept before any of their business
 * data reaches an LLM or agent. ONE versioned constant: the UI shows it, the server gates on its
 * `version`. Changing the text means a new `version` (e.g. `terminos-v2`), which makes every user
 * accept again. Client-safe (no server imports).
 *
 * Retention periods, withdrawal procedure, legal deadlines and a direct contact address are
 * still open owner decisions (docs/personal-data.md); they are deliberately not in the text.
 */
export interface TermsDocument {
  readonly version: string;
  readonly title: string;
  readonly intro: string;
  readonly sections: ReadonlyArray<{ readonly heading: string; readonly body: string }>;
}

export const CURRENT_TERMS: TermsDocument = {
  version: 'terminos-v1',
  title: 'Términos de uso y tratamiento de datos personales',
  intro:
    'Antes de empezar, lee cómo usamos la información que compartes en CreaMype. Para usar el asistente necesitas aceptar estos términos.',
  sections: [
    {
      heading: 'Para qué usamos tus datos',
      body:
        'Usamos la información que compartes en el chat (por ejemplo, el nombre de tu negocio, su rubro, el estilo que buscas y tu producto) solo para conversar contigo y crear los entregables de marca que pidas, como tu logo. No la usamos para publicidad ni la vendemos.',
    },
    {
      heading: 'Qué guardamos y dónde',
      body:
        'Guardamos tu correo electrónico y tu pertenencia a tu organización, los mensajes de tus conversaciones, los datos de tu negocio que se extraen de ellos, los entregables generados (como las imágenes de tu logo) y un registro técnico de cada solicitud para poder recuperarla si algo falla. Todo se guarda en la base de datos y en el almacenamiento privado de archivos de la plataforma, separado por organización: otras organizaciones no pueden ver tu información. Dentro de tu organización, solo tú y las personas administradoras de tu organización pueden ver tus conversaciones.',
    },
    {
      heading: 'Con quién compartimos tus datos',
      body:
        'No compartimos tus datos con terceros, salvo con los proveedores que necesitamos para producir tus entregables: los servicios de modelos de inteligencia artificial que interpretan tus mensajes y redactan las respuestas, y el servicio de generación de imágenes que crea tu logo. Cada uno recibe solo la información necesaria para atender tu solicitud. Además, la plataforma usa un servicio de inicio de sesión y servicios de alojamiento que guardan la información por encargo nuestro.',
    },
    {
      heading: 'Solo lo necesario',
      body:
        'Te pedimos solo los datos que necesitamos para crear tu marca. No compartas en el chat datos personales que no hagan falta, como tu DNI, tu dirección, datos bancarios o información de salud.',
    },
    {
      heading: 'Marco legal',
      body:
        'El tratamiento de tus datos personales se rige por la Ley N.º 29733, Ley de Protección de Datos Personales del Perú, y su reglamento. Puedes ejercer los derechos que esa ley te reconoce, como acceder a tus datos, rectificarlos, cancelarlos u oponerte a su tratamiento.',
    },
    {
      heading: 'Contacto',
      body:
        'Si tienes preguntas sobre tus datos o quieres ejercer tus derechos, comunícate con el equipo de CreaMype a través del administrador de tu organización.',
    },
    {
      heading: 'Cambios en estos términos',
      body:
        'Si cambiamos estos términos, te los mostraremos de nuevo y tendrás que aceptarlos antes de seguir usando el asistente.',
    },
  ],
};

export const CURRENT_TERMS_VERSION = CURRENT_TERMS.version;

/** Shown when a protected request arrives without acceptance of the current version. */
export const TERMS_REQUIRED_MESSAGE =
  'Antes de continuar, revisa y acepta los términos de uso y tratamiento de datos. Recarga la página para verlos.';

/** Shown when the acceptance cannot be verified (the gate fails closed). */
export const TERMS_UNAVAILABLE_MESSAGE =
  'No pudimos verificar tu aceptación de los términos. Inténtalo de nuevo.';
