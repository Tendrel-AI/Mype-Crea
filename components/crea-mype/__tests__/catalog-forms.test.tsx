import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BRAND_CATALOG, PRODUCT_CATALOG } from '../../../src/core/brand-catalog';
import { emptyValue, type FormValues } from '../CatalogFields';
import { CatalogFormView, runSubmit } from '../CatalogForm';
import { BrandForm, FileInputs } from '../BrandForm';
import { ProductForm } from '../ProductForm';

const noop = () => {};
const emptyValues = (fields: typeof BRAND_CATALOG): FormValues => Object.fromEntries(fields.map((f) => [f.key, emptyValue(f)]));
const filledBrand = (): FormValues => ({
  ...emptyValues(BRAND_CATALOG), business_name: 'Café Andino', business_category: 'Café', market_proposition: 'Café de altura', target_audience: 'Jóvenes',
});

const view = (props: Partial<React.ComponentProps<typeof CatalogFormView>>) => renderToStaticMarkup(
  <CatalogFormView prefix="t" fields={BRAND_CATALOG} values={emptyValues(BRAND_CATALOG)} errors={{}} formError="" busy={false}
    submitLabel="Crear marca" onChange={noop} onSubmit={noop} onCancel={noop} {...props} />,
);

describe('BrandForm', () => {
  it('marks the required fields and offers «Aún no tengo nombre»; «Crear marca» hides import-only fields', () => {
    const markup = renderToStaticMarkup(<BrandForm mode="create" onSubmit={async () => ({ ok: true })} onCancel={noop} />);
    expect(markup).toContain('Aún no tengo nombre');
    expect(markup.match(/\(obligatorio\)/g)).toHaveLength(4);
    expect(markup).toContain('Lema o eslogan (opcional)');
    expect(markup).not.toContain('Redes sociales actuales');
    expect(markup).not.toContain('Logo');
  });

  it('«Ya tengo una marca» adds the tagline, social accounts, logo and up to 5 files', () => {
    const markup = renderToStaticMarkup(<BrandForm mode="import" onSubmit={async () => ({ ok: true })} onCancel={noop} />);
    expect(markup).toContain('Lema actual');
    expect(markup).toContain('Redes sociales actuales');
    expect(markup).toContain('type="file"');
    expect(markup).toContain('hasta 5');
  });

  it('edit mode is prefilled and offers saving', () => {
    const markup = renderToStaticMarkup(<BrandForm mode="edit" initialValues={{ business_name: 'Café Andino', color_palette: ['#FF0000'] }} onSubmit={async () => ({ ok: true })} onCancel={noop} />);
    expect(markup).toContain('value="Café Andino"');
    expect(markup).toContain('value="#FF0000"');
    expect(markup).toContain('Guardar cambios');
  });

  it('a pending name disables the name field and checks the box', () => {
    const markup = renderToStaticMarkup(<BrandForm mode="edit" initialValues={{ name_pending: true }} onSubmit={async () => ({ ok: true })} onCancel={noop} />);
    expect(markup).toMatch(/<input[^>]*id="[^"]*business_name"[^>]*disabled/);
    expect(markup).toMatch(/<input type="checkbox" checked=""[^>]*\/>Aún no tengo nombre/);
  });
});

describe('form errors are always visible', () => {
  it('required-field errors stop the submit locally and render next to each field', async () => {
    const onSubmit = vi.fn(async () => ({ ok: true as const }));
    const outcome = await runSubmit('brand', BRAND_CATALOG, emptyValues(BRAND_CATALOG), onSubmit);
    expect(outcome.sent).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(Object.keys(outcome.errors).sort()).toEqual(['business_category', 'business_name', 'market_proposition', 'target_audience']);
    const markup = view({ errors: outcome.errors, formError: outcome.formError });
    expect(markup).toContain('Completa «Nombre del negocio».');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup.match(/role="alert"/g)!.length).toBeGreaterThanOrEqual(5);
  });

  it('a server refusal is rendered: per-field errors beside the fields and the message in an alert', async () => {
    const outcome = await runSubmit('brand', BRAND_CATALOG, filledBrand(), async () => ({
      ok: false, message: 'Revisa los campos marcados.', fieldErrors: { business_category: 'El servidor no lo acepta.' },
    }));
    expect(outcome).toMatchObject({ sent: true, ok: false, errors: { business_category: 'El servidor no lo acepta.' } });
    const markup = view({ values: filledBrand(), errors: outcome.errors, formError: outcome.formError });
    expect(markup).toContain('El servidor no lo acepta.');
    expect(markup).toContain('Revisa los campos marcados.');
  });

  it('a server limit refusal without fields (brand limit) and a thrown action both show their message', async () => {
    const limit = await runSubmit('brand', BRAND_CATALOG, filledBrand(), async () => ({ ok: false, message: 'Llegaste al límite de 3 marcas de tu organización.' }));
    expect(view({ values: filledBrand(), formError: limit.formError })).toContain('Llegaste al límite de 3 marcas');
    const thrown = await runSubmit('brand', BRAND_CATALOG, filledBrand(), async () => { throw new Error('network'); });
    expect(thrown).toMatchObject({ sent: true, ok: false });
    expect(view({ values: filledBrand(), formError: thrown.formError })).toContain('No pudimos guardar los datos. Inténtalo de nuevo.');
  });

  it('sends the typed payload on success: money as a number, name_pending as a boolean', async () => {
    const onSubmit = vi.fn(async () => ({ ok: true as const }));
    const values: FormValues = {
      ...emptyValues(PRODUCT_CATALOG), product_name: 'Café molido', food_denomination: 'Café tostado', package_type: 'Bolsa',
      product_presentations: [{ label: '250 g', principal: true }], price_pen: '12.50',
    };
    expect(await runSubmit('product', PRODUCT_CATALOG, values, onSubmit)).toMatchObject({ ok: true, sent: true });
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ price_pen: 12.5 }));
    await runSubmit('brand', BRAND_CATALOG, { ...filledBrand(), name_pending: true }, onSubmit);
    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ name_pending: true }));
  });

  it('disables the controls and shows progress while busy (no double submit)', () => {
    const markup = view({ busy: true });
    expect(markup).toContain('Guardando…');
    expect(markup).toMatch(/<button type="submit" disabled=""[^>]*aria-busy="true"/);
  });
});

describe('ProductForm', () => {
  it('renders presentations as a repeatable list with a «Principal» radio, exactly one checked', () => {
    const markup = renderToStaticMarkup(
      <ProductForm mode="edit" initialValues={{ product_presentations: [{ label: '250 g', principal: false }, { label: '1 kg', principal: true }] }} onSubmit={async () => ({ ok: true })} onCancel={noop} />,
    );
    expect(markup.match(/type="radio"/g)).toHaveLength(2);
    expect(markup.match(/type="radio" name="[^"]*" checked=""/g)).toHaveLength(1);
    expect(markup).toContain('Agregar presentación');
    expect(markup).toContain('Principal');
  });

  it('shows «Heredado de la marca» for an empty override and hides it once the product has its own value', () => {
    const brandAttributes = { differentiator: 'Café de altura', color_palette: ['#FF0000'] };
    const inherited = renderToStaticMarkup(<ProductForm mode="create" brandAttributes={brandAttributes} onSubmit={async () => ({ ok: true })} onCancel={noop} />);
    expect(inherited).toContain('Heredado de la marca: Café de altura');
    expect(inherited).toContain('Heredado de la marca: #FF0000');
    const own = renderToStaticMarkup(<ProductForm mode="edit" initialValues={{ differentiator: 'Propio' }} brandAttributes={brandAttributes} onSubmit={async () => ({ ok: true })} onCancel={noop} />);
    expect(own).not.toContain('Heredado de la marca: Café de altura');
  });

  it('marks the four required product fields', () => {
    const markup = renderToStaticMarkup(<ProductForm mode="create" onSubmit={async () => ({ ok: true })} onCancel={noop} />);
    expect(markup.match(/\(obligatorio\)/g)).toHaveLength(4);
    expect(markup).toContain('Crear producto');
  });
});

describe('upload failure after the data was saved', () => {
  it('shows the upload error and the pending file next to the file field', () => {
    const html = renderToStaticMarkup(
      <FileInputs existing={[]} files={{ logo: new File(['x'], 'logo.png'), assets: [] }} onChange={noop} disabled={false} uploadErrors={['logo.png: pesa demasiado']} />,
    );
    expect(html).toContain('logo.png: pesa demasiado');
    expect(html).toContain('Pendientes de subir: logo.png');
  });
});
