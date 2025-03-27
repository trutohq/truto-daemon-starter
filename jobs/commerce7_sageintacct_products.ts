import { get, isEmpty, map, omit } from 'lodash-es'
import { Job, log } from '@truto/truto-daemon'

type Commerce7Product = {
  id: string
  title: string
  teaser: string
  variants: Array<{
    price: string
    sku: string
  }>
}

class Commerce7SageintacctProduct extends Job {
  async run() {
    log.setBindings({
      job: 'Commerce7SageintacctProduct',
    })
    await this.refreshIntegratedAccountCredentials(
      this.daemonJobRun.args?.sage_integrated_account_id as string
    )
    const products = await this.listFromSource<Commerce7Product>({
      resource: 'products',
      integrated_account_id: this.daemonJobRun.args
        ?.commerce7_integrated_account_id as string,
    })
    for await (const product of products) {
      const variants = get(product, 'variants', [])
      const productsToCreate = map(variants, variant => {
        return {
          ...variant,
          product: omit(product, 'variants'),
        }
      })
      for await (const productToCreate of productsToCreate) {
        const checkProductExistsOnSage = await this.queryInDestination<
          Array<{ key: string; id: string; name: string; itemType: string }>
        >(
          {
            object: 'inventory-control/item',
            fields: ['key', 'id', 'name', 'itemType'],
            filters: [
              {
                $eq: {
                  id: productToCreate.sku,
                },
              },
            ],
          },
          {
            resource: 'query',
            integrated_account_id: this.daemonJobRun.args
              ?.sage_integrated_account_id as string,
          }
        )
        if (!isEmpty(checkProductExistsOnSage)) {
          log.info(
            `Product already exists in Sage Intacct: ${productToCreate.sku}`
          )
          continue
        }
        const response = await this.createProductInSageIntacct(productToCreate)
        if (response?.id) {
          log.info(`Product created in Sage Intacct: ${response.id}`)
          await this.sqlite
            .insertInto('state')
            .values({
              key: `product_${productToCreate.sku}`,
              value: response.id,
              metadata: JSON.stringify({
                commerce7_id: product.id,
                sageIntactt_id: response.key,
              }),
            })
            .execute()
        }
      }
    }
  }

  async createProductInSageIntacct(product: {
    product: Pick<Commerce7Product, 'title' | 'teaser'>
    price: string
    sku: string
  }) {
    const existingProduct = await this.sqlite
      .selectFrom('state')
      .selectAll()
      .where('key', '=', `product_${product.sku}`)
      .executeTakeFirst()
    if (existingProduct) {
      log.info(
        `Product already exists in Sage Intacct: ${existingProduct.value}`
      )
      return
    }
    try {
      return await this.createInDestination<{ id: string; key: string }>(
        {
          id: product.sku,
          name: product.product.title,
          status: 'active',
          costMethod: 'standard',
          notes: product.product.teaser,
          itemType: 'inventory',
          sales: {
            basePrice: (parseInt(product.price) / 100).toFixed(2),
          },
        },
        {
          resource: 'items',
          integrated_account_id: this.daemonJobRun.args
            ?.sage_integrated_account_id as string,
        }
      )
    } catch (error: any) {
      log.error(`Error creating product in Sage Intacct: ${error.message}`)
    }
    return
  }
}

new Commerce7SageintacctProduct()
