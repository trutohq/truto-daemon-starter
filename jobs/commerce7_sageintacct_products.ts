import { get, map, omit } from 'lodash-es'
import { Cursor } from '@truto/truto-ts-sdk'
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
    const products = this.listProductsFromCommerce7()
    for await (const product of products) {
      const variants = get(product, 'variants', [])
      const productsToCreate = map(variants, variant => {
        return {
          ...variant,
          product: omit(product, 'variants'),
        }
      })
      for await (const productToCreate of productsToCreate) {
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

  listProductsFromCommerce7() {
    return this.trutoApi.proxyApi.list({
      resource: 'products',
      integrated_account_id: this.daemonJobRun.args
        ?.commerce7_integrated_account_id as string,
    }) as Cursor<Commerce7Product>
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
    return this.trutoApi.proxyApi.create(
      {
        id: product.sku,
        name: product.product.title,
        status: 'active',
        costMethod: 'standard',
        notes: product.product.teaser,
        itemType: 'inventory',
        sales: {
          basePrice: product.price.toString(),
        },
      },
      {
        resource: 'items',
        integrated_account_id: this.daemonJobRun.args
          ?.sage_integrated_account_id as string,
      }
    )
  }
}

new Commerce7SageintacctProduct()
