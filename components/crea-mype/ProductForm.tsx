'use client';

import React from 'react';
import { PRODUCT_CATALOG } from '../../src/core/brand-catalog';
import { CatalogForm, type FormResult } from './CatalogForm';

/** «Nuevo producto» / «Editar producto»: the product catalog as a form; overrides show the brand's value as a hint. */
export function ProductForm({ mode, initialValues, brandAttributes, onSubmit, onCancel }: {
  mode: 'create' | 'edit';
  initialValues?: Record<string, unknown>;
  brandAttributes?: Record<string, unknown>;
  onSubmit: (attributes: Record<string, unknown>) => Promise<FormResult>;
  onCancel: () => void;
}) {
  return (
    <CatalogForm
      level="product"
      fields={PRODUCT_CATALOG}
      initialValues={initialValues}
      inherited={brandAttributes}
      submitLabel={mode === 'edit' ? 'Guardar cambios' : 'Crear producto'}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}

export const productFormTitle = (mode: 'create' | 'edit') => (mode === 'edit' ? 'Editar producto' : 'Nuevo producto');
