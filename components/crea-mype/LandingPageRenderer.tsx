'use client';

/* eslint-disable @next/next/no-img-element -- Typed content allows validated URLs from customer-selected hosts. */

import React from 'react';
import { parseLandingPageContent } from '../../src/landing-page/contract';
import { LandingHtmlPreviewFrame } from './LandingHtmlPreviewFrame';

type Props = {
  content: unknown;
  logoUrl?: string;
  labelUrl?: string;
  title: string;
  className: string;
};

/** Chooses validated typed React content or the compatible sandboxed legacy preview. */
export function LandingPageRenderer({ content, logoUrl, labelUrl, title, className }: Props) {
  const parsed = parseLandingPageContent(content);
  if (!parsed.success) return <div className={className} role="status">No se pudo mostrar esta página web.</div>;
  if (parsed.data.format === 'legacy-html') {
    return <LandingHtmlPreviewFrame html={parsed.data.html} logoUrl={logoUrl} labelUrl={labelUrl} title={title} className={className} />;
  }

  return (
    <main className={`${className} overflow-auto bg-neutral-50 text-neutral-900`} aria-label="Vista previa de la página web">
      {parsed.data.sections.map((section, index) => {
        const Heading = index === 0 ? 'h1' : 'h2';
        const Subheading = index === 0 ? 'h2' : 'h3';
        switch (section.kind) {
          case 'hero':
            return <section key={`${section.kind}-${index}`} className="mx-auto max-w-5xl px-6 py-12 text-center">
              <Heading className="text-4xl font-bold tracking-tight">{section.heading}</Heading>
              <p className="mx-auto mt-4 max-w-2xl text-lg text-neutral-700">{section.supportingText}</p>
              {section.imageUrl && <img className="mx-auto mt-8 max-h-96 max-w-full rounded-xl object-contain" src={section.imageUrl} alt="" />}
              {section.callToAction && <a className="mt-6 inline-flex rounded-lg bg-orange-600 px-5 py-3 font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-700" href={section.callToAction.url} target="_blank" rel="noopener noreferrer">{section.callToAction.label}</a>}
            </section>;
          case 'benefits':
            return <section key={`${section.kind}-${index}`} className="mx-auto max-w-5xl px-6 py-10">
              <Heading className="text-2xl font-semibold">{section.heading}</Heading>
              <ul className="mt-5 grid gap-4 sm:grid-cols-2">{section.benefits.map((benefit, itemIndex) => <li key={itemIndex} className="rounded-xl border border-neutral-200 bg-white p-5"><Subheading className="font-semibold">{benefit.heading}</Subheading><p className="mt-2 text-neutral-700">{benefit.body}</p></li>)}</ul>
            </section>;
          case 'gallery':
            return <section key={`${section.kind}-${index}`} className="mx-auto max-w-5xl px-6 py-10">
              <Heading className="text-2xl font-semibold">{section.heading}</Heading>
              <ul className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{section.images.map((image, itemIndex) => <li key={itemIndex} className="overflow-hidden rounded-xl border border-neutral-200 bg-white"><img className="h-56 w-full object-cover" src={image.imageUrl} alt={image.alt} />{image.caption && <p className="p-3 text-sm text-neutral-700">{image.caption}</p>}</li>)}</ul>
            </section>;
          case 'callToAction':
            return <section key={`${section.kind}-${index}`} className="bg-neutral-100 px-6 py-12 text-center">
              <Heading className="text-2xl font-semibold">{section.heading}</Heading><p className="mx-auto mt-3 max-w-2xl text-neutral-700">{section.supportingText}</p>
              <a className="mt-6 inline-flex rounded-lg bg-orange-600 px-5 py-3 font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-700" href={section.url} target="_blank" rel="noopener noreferrer">{section.label}</a>
            </section>;
          case 'contact':
            return <section key={`${section.kind}-${index}`} className="mx-auto max-w-5xl px-6 py-10">
              <Heading className="text-2xl font-semibold">{section.heading}</Heading>
              <ul className="mt-4 space-y-3">{section.methods.map((method, itemIndex) => <li key={itemIndex} className="text-neutral-700">{method.url ? <a className="underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-700" href={method.url} target="_blank" rel="noopener noreferrer">{method.label}{method.value ? `: ${method.value}` : ''}</a> : <span>{method.label}{method.value ? `: ${method.value}` : ''}</span>}</li>)}</ul>
            </section>;
        }
      })}
    </main>
  );
}
