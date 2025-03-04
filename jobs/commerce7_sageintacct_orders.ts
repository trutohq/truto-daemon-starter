import { get, toString } from 'lodash-es'
import { Cursor } from '@truto/truto-ts-sdk'
import { Job, log } from '@truto/truto-daemon'

type Commerce7Order = {
  id: string
  customerId: string
  purchaseType: string
  paymentStatus: string
  orderSubmittedDate: string
  customer: {
    firstName: string
    lastName: string
    email: string
    products: Array<{
      product: {
        sku: string
        price: number
        quantity: number
      }
    }>
  }
}

type Commerce7Customer = {
  id: string
  firstName: string
  lastName: string
  emails: Array<{
    email: string
  }>
}

type SageintacctCustomers = Array<{
  id: string
  key: string
}>

class Commerce7SageintacctOrders extends Job {
  async run() {
    log.setBindings({
      job: 'Commerce7SageintacctOrders',
    })
    const orders = (await this.trutoApi.proxyApi.list({
      resource: 'orders',
      integrated_account_id: this.daemonJobRun.args
        ?.commerce7_integrated_account_id as string,
      limit: 1,
    })) as Cursor<Commerce7Order>

    for await (const order of orders) {
      if (order.purchaseType != 'Refund') {
        log.info(`Processing order ${order.id}`)
        const customer = (await this.trutoApi.proxyApi.get(order.customerId, {
          resource: 'customers',
          integrated_account_id: this.daemonJobRun.args
            ?.commerce7_integrated_account_id as string,
        })) as Commerce7Customer

        const customerEmail = get(customer, 'emails[0].email')
        log.info(`Commerce7 Customer: ${customerEmail}`)

        const sageIntacctCustomers = (await this.trutoApi.proxyApi.create(
          {
            object: 'accounts-receivable/customer',
            fields: ['id', 'key'],
            filters: [{ $eq: { 'contacts.default.email1': customerEmail } }],
          },
          {
            resource: 'query',
            integrated_account_id: this.daemonJobRun.args
              ?.sage_integrated_account_id as string,
          }
        )) as SageintacctCustomers
        const sageIntacctCustomerId = get(sageIntacctCustomers, '[0].id')
        const sageIntacctCustomerKey = get(sageIntacctCustomers, '[0].key')

        log.info(`Sage Intacct Customer Key: ${sageIntacctCustomerKey}`)

        const commerce7Products = order.customer.products
        type ItemDetails = {
          price: number
          quantity: number
        }
        const itemIds: Record<string, ItemDetails> = {}
        const warehouseIds: Record<string, string> = {}

        for (const product of commerce7Products) {
          const itemId = get(product, 'product.sku')
          log.info(`Commerce7 Item: ${itemId}`)
          const sageintacctItem = await this.trutoApi.proxyApi.create(
            {
              object: 'inventory-control/item',
              fields: ['id'],
              filters: [{ $eq: { id: itemId } }],
            },
            {
              resource: 'query',
              integrated_account_id: this.daemonJobRun.args
                ?.sage_integrated_account_id as string,
            }
          )

          const sageintacctItemId = get(sageintacctItem, '[0].id')
          itemIds[sageintacctItemId] = {
            price: get(product, 'product.price'),
            quantity: get(product, 'product.quantity'),
          }
          log.info(`Sage Intacct Item: ${sageintacctItemId}`)

          const sageintacctWarehouses = await this.trutoApi.proxyApi.create(
            {
              object: 'inventory-control/item-warehouse-inventory',
              fields: ['id', 'item.id', 'warehouse.id'],
              filters: [{ $eq: { 'item.id': sageintacctItemId } }],
            },
            {
              resource: 'query',
              integrated_account_id: this.daemonJobRun.args
                ?.sage_integrated_account_id as string,
            }
          )

          const sageintacctWarehouseId = get(
            sageintacctWarehouses,
            '[0]["warehouse.id"]'
          )
          warehouseIds[sageintacctItemId] = sageintacctWarehouseId

          log.info(`Sage Intacct Warehouse: ${sageintacctWarehouseId}`)
        }

        const body = {
          customer: {
            id: sageIntacctCustomerId,
          },
          state: 'submitted',
          txnDate: order.orderSubmittedDate.split('T')[0],
          txnCurrency: 'USD',
          baseCurrency: 'USD',
          lines: Object.entries(itemIds).map(([itemId, details]) => ({
            dimensions: {
              item: {
                id: itemId,
              },
              warehouse: {
                id: warehouseIds[itemId],
              },
              location: {
                id: warehouseIds[itemId],
              },
            },
            unit: 'Each',
            unitQuantity: toString(details.quantity),
            unitPrice: toString(details.price),
          })),
        }

        log.info(`body: ${JSON.stringify(body, null, 2)}`)

        const pushOrder = await this.trutoApi.proxyApi.create(body, {
          document_name: 'Sales Order',
          resource: 'order_entry_document',
          integrated_account_id: this.daemonJobRun.args
            ?.sage_integrated_account_id as string,
        })
        log.info(`Order created : ${pushOrder.id}`)
      }
    }
  }
}

new Commerce7SageintacctOrders()
