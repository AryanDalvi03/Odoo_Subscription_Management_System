import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Layers3, Check } from 'lucide-react';
import { toast } from 'sonner';
import { api, command, errorMessage, money, type Row } from '../lib/api';
import { Modal } from '../components/Modal';
import { Button } from '../components/ui/button';
export function Catalog() {
  const [selected, setSelected] = useState<Row | null>(null);
  const plans = useQuery({
    queryKey: ['catalog'],
    queryFn: async () =>
      (await api.get('/plans', { params: { pageSize: 100 } })).data.data as Row[],
  });
  return (
    <section className="sq-page">
      <div className="sq-page-heading">
        <div>
          <span className="eyebrow">BUILT AROUND YOUR NEEDS</span>
          <h1>Find your next plan.</h1>
          <p>Explore available software plans and request a quotation with clear pricing.</p>
        </div>
      </div>
      {plans.isError ? (
        <div className="error" role="alert">
          {errorMessage(plans.error)}
        </div>
      ) : plans.isPending ? (
        <div className="sq-skeleton">Loading plans…</div>
      ) : !plans.data.length ? (
        <div className="sq-empty">
          <Layers3 size={32} />
          <h2>No plans available yet</h2>
          <p>Brightloop Software will publish available plans here.</p>
        </div>
      ) : (
        <div className="sq-plan-grid">
          {plans.data.map((plan) => (
            <article className="sq-plan-card" key={plan._id}>
              <span className="service-icon">
                <Layers3 size={22} />
              </span>
              <h2>{String(plan.name)}</h2>
              <p>{String(plan.description ?? '')}</p>
              <strong>
                {money(
                  (plan.products as { unitPriceMinor: number }[]).reduce(
                    (sum, p) => sum + p.unitPriceMinor,
                    0,
                  ),
                )}
                <small> / {String(plan.frequency).replace('ly', '')}</small>
              </strong>
              <ul>
                <li>
                  <Check size={15} />
                  Minimum quantity: {String(plan.minQuantity)}
                </li>
                <li>
                  <Check size={15} />
                  {(plan.products as unknown[]).length} included product(s)
                </li>
                <li>
                  <Check size={15} />
                  {(plan.allowPause ? 'Pause available' : 'Continuous billing') as string}
                </li>
              </ul>
              <Button onClick={() => setSelected(plan)}>Request quotation</Button>
            </article>
          ))}
        </div>
      )}
      {selected && (
        <Modal title={`Request ${selected.name}`} onClose={() => setSelected(null)}>
          <PlanRequest plan={selected} onDone={() => setSelected(null)} />
        </Modal>
      )}
    </section>
  );
}
function PlanRequest({ plan, onDone }: { plan: Row; onDone: () => void }) {
  const [quantity, setQuantity] = useState(Number(plan.minQuantity));
  const [variants, setVariants] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const products = plan.products as { productId: string; unitPriceMinor: number }[];
  const choices = useQuery({
    queryKey: ['plan-variants', plan._id],
    queryFn: async () => {
      const results = await Promise.all(
        products.map((product) => api.get(`/products/${product.productId}/variants`)),
      );
      return Object.fromEntries(
        results.map((response, index) => [products[index]!.productId, response.data.data as Row[]]),
      );
    },
  });
  const total =
    products.reduce(
      (sum, product) =>
        sum +
        product.unitPriceMinor +
        Number(
          choices.data?.[product.productId]?.find((row) => row._id === variants[product.productId])
            ?.additionalPriceMinor ?? 0,
        ),
      0,
    ) * quantity;
  return (
    <form
      className="resource-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setError('');
        try {
          const profile = (await api.get('/me')).data.data;
          await command('/quotations', {
            customerId: profile.customer._id,
            planId: plan._id,
            quantity,
            variants: Object.fromEntries(
              Object.entries(variants).filter(([, value]) => Boolean(value)),
            ),
            expiryAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
            terms: '',
          });
          await qc.invalidateQueries({ queryKey: ['resources'] });
          toast.success('Quotation requested. The team will review and send it for acceptance.');
          onDone();
          navigate('/app/quotations');
        } catch (error) {
          setError(errorMessage(error));
        } finally {
          setSaving(false);
        }
      }}
    >
      <label>
        Quantity
        <input
          type="number"
          min={Number(plan.minQuantity)}
          max={100000}
          value={quantity}
          required
          onChange={(event) => setQuantity(Number(event.target.value))}
        />
      </label>
      {products.map((product, index) => (
        <label key={product.productId}>
          Product {index + 1} variant
          <select
            value={variants[product.productId] ?? ''}
            onChange={(event) =>
              setVariants({ ...variants, [product.productId]: event.target.value })
            }
          >
            <option value="">Standard · {money(product.unitPriceMinor)}</option>
            {choices.data?.[product.productId]?.map((variant) => (
              <option value={variant._id} key={variant._id}>
                {String(variant.name)} · +{money(variant.additionalPriceMinor)}
              </option>
            ))}
          </select>
        </label>
      ))}
      <div className="sq-quote-preview full">
        <span>Estimated recurring subtotal</span>
        <strong>{money(total)}</strong>
        <small>Applicable taxes and eligible discounts are calculated by the server.</small>
      </div>
      {error && (
        <div className="error full" role="alert">
          {error}
        </div>
      )}
      <Button type="submit" disabled={saving || choices.isPending}>
        {saving ? 'Requesting…' : 'Request quotation'}
      </Button>
    </form>
  );
}
