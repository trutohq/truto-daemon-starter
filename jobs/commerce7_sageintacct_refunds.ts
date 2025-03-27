import { get, isEmpty, toString } from 'lodash-es'
import { Job, log } from '@truto/truto-daemon'
import { ofetch } from 'ofetch'

type Commerce7Order = {
  id: string
  customerId: string
  purchaseType: string
  paymentStatus: string
  orderSubmittedDate: string
  items: Array<{
    sku: string
    price: number
    quantity: number
  }>
  customer: {
    firstName: string
    lastName: string
    email: string
    products: Array<{
      product: {
        sku: string
        price: number
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

// type SageintacctCustomers = Array<{
//   id: string
//   key: string
// }>

class Commerce7SageintacctRefunds extends Job {
  async run() {
    log.setBindings({
      job: 'Commerce7SageintacctRefunds',
    })

    const commerce7IntegratedAccountId = this.daemonJobRun.args
      ?.commerce7_integrated_account_id as string
    const sageIntegratedAccountId = this.daemonJobRun.args
      ?.sage_integrated_account_id as string

    if (!commerce7IntegratedAccountId || !sageIntegratedAccountId) {
      throw new Error('Missing required integrated account IDs')
    }

    const orders = await this.listFromSource<Commerce7Order>({
      resource: 'orders',
      integrated_account_id: commerce7IntegratedAccountId,
      limit: 1,
    })

    for await (const order of orders) {
      if (order.purchaseType == 'Refund') {
        log.info(`Processing order ${order.id}`)
        const exists = await this.checkExistingState(
          `order_commerce7_${order.id}`
        )
        if (exists) {
          log.info(`Order already synced in Sage Intacct: ${order.id}`)
          return
        }

        const customer = await this.getFromSource<Commerce7Customer>(
          order.customerId,
          {
            resource: 'customers',
            integrated_account_id: commerce7IntegratedAccountId,
          }
        )

        const customerEmail = get(customer, 'emails[0].email')
        if (!customerEmail) {
          log.error(`Customer email not found for order ${order.id}`)
          continue
        }
        log.info(`Commerce7 Customer: ${customerEmail}`)

        const sageIntacctCustomers = await this.queryInDestination<
          Array<{ id: string; key: string }>
        >(
          {
            object: 'accounts-receivable/customer',
            fields: ['id', 'key'],
            filters: [{ $eq: { 'contacts.default.email1': customerEmail } }],
          },
          {
            resource: 'query',
            integrated_account_id: sageIntegratedAccountId,
          }
        )

        let sageIntacctCustomerId = ''
        let sageIntacctCustomerKey = ''
        if (
          Array.isArray(sageIntacctCustomers) &&
          sageIntacctCustomers.length > 0
        ) {
          sageIntacctCustomerId = sageIntacctCustomers[0].id || ''
          sageIntacctCustomerKey = sageIntacctCustomers[0].key || ''
        }

        if (isEmpty(sageIntacctCustomers)) {
          const createdSageIntacctCustomer = await this.createInDestination<{
            id: string
            key: string
          }>(
            {
              name: `${customer.firstName} ${customer.lastName}`,
              status: 'active',
              contacts: {
                default: {
                  email1: customerEmail,
                },
              },
            },
            {
              resource: 'customers',
              integrated_account_id: sageIntegratedAccountId,
            }
          )
          sageIntacctCustomerId = createdSageIntacctCustomer.id || ''
          sageIntacctCustomerKey = createdSageIntacctCustomer.key || ''
        }

        if (!sageIntacctCustomerId || !sageIntacctCustomerKey) {
          log.error(
            `Failed to get or create Sage Intacct customer for order ${order.id}`
          )
          continue
        }

        log.info(`Sage Intacct Customer Key: ${sageIntacctCustomerKey}`)

        const commerce7Items = order.items
        type commerce7ShippingObject = Array<{
          title: string
          code: string
        }>
        const commerce7Shipping = get(
          order,
          'shipping',
          []
        ) as commerce7ShippingObject
        let sageIntacctShippingKey = ''
        let sageIntacctShippingId = ''
        if (!isEmpty(commerce7Shipping)) {
          const shippingTitle = commerce7Shipping[0]?.title
          if (!shippingTitle) {
            log.error('Shipping title is undefined')
            continue
          }
          const sageIntacctShipping = await this.queryInDestination<
            Array<{ id: string; key: string }>
          >(
            {
              object: 'accounts-receivable/shipping-method',
              fields: ['id', 'key'],
              filters: [{ $eq: { id: shippingTitle } }],
            },
            {
              resource: 'query',
              integrated_account_id: sageIntegratedAccountId,
            }
          )

          if (
            Array.isArray(sageIntacctShipping) &&
            sageIntacctShipping.length > 0
          ) {
            sageIntacctShippingKey = sageIntacctShipping[0].key || ''
            sageIntacctShippingId = sageIntacctShipping[0].id || ''
          }

          log.info(
            `Matching shipping Details In Sage Intacct: ${JSON.stringify(
              sageIntacctShipping,
              null
            )}`
          )
          if (isEmpty(sageIntacctShipping)) {
            const createdShipping = await this.createInDestination<{
              id: string
              key: string
            }>(
              {
                id: shippingTitle,
              },
              {
                resource: 'shipping_methods',
                integrated_account_id: sageIntegratedAccountId,
              }
            )
            sageIntacctShippingKey = createdShipping.key || ''
            sageIntacctShippingId = createdShipping.id || ''
          }
        }

        const commerce7PaymentType = get(order, 'tenders[0].tenderType', '')
        const paymentTypeMapping: Record<string, string> = {
          'Credit Card': 'Credit Card',
          Cash: 'Cash',
          COD: 'Printed Check',
          External: 'Online',
          Debit: 'Debit',
          'Gift Card': 'Gift Card',
          Other: 'Other',
          Alipay: 'Alipay',
          'WeChat Pay': 'WeChat Pay',
          'Loyalty Points': 'Loyalty Points',
        }
        const sage7PaymentType: string =
          paymentTypeMapping[commerce7PaymentType] || 'Cash'

        type ItemDetails = {
          price: number
          quantity: number
        }
        const itemIds: Record<string, ItemDetails> = {}
        const warehouseIds: Record<string, string> = {}

        for (const item of commerce7Items) {
          const itemId = get(item, 'sku')
          log.info(`Commerce7 Item: ${itemId}`)
          const sageintacctItem = await this.queryInDestination(
            {
              object: 'inventory-control/item',
              fields: ['id'],
              filters: [{ $eq: { id: itemId } }],
            },
            {
              resource: 'query',
              integrated_account_id: sageIntegratedAccountId,
            }
          )

          const sageintacctItemId = get(sageintacctItem, '[0].id')
          if (!sageintacctItemId) {
            log.error(`Item not found in Sage Intacct: ${itemId}`)
            continue
          }
          itemIds[sageintacctItemId] = {
            price: parseInt(this.formatPrice(get(item, 'price'))),
            quantity: get(item, 'quantity') * -1,
          }
          log.info(`Sage Intacct Item: ${sageintacctItemId}`)

          const sageintacctWarehouses = await this.queryInDestination(
            {
              object: 'inventory-control/item-warehouse-inventory',
              fields: ['id', 'item.id', 'warehouse.id'],
              filters: [{ $eq: { 'item.id': sageintacctItemId } }],
            },
            {
              resource: 'query',
              integrated_account_id: sageIntegratedAccountId,
            }
          )

          const sageintacctWarehouseId = get(
            sageintacctWarehouses,
            '[0]["warehouse.id"]'
          )
          if (!sageintacctWarehouseId) {
            log.error(`Warehouse not found for item ${itemId}`)
            continue
          }
          warehouseIds[sageintacctItemId] = sageintacctWarehouseId

          log.info(`Sage Intacct Warehouse: ${sageintacctWarehouseId}`)
        }

        const body = {
          customer: {
            id: sageIntacctCustomerId,
          },
          txnDate: order.orderSubmittedDate.split('T')[0],
          txnCurrency: this.getDefaultCurrency(),
          shippingMethod: !isEmpty(commerce7Shipping)
            ? {
                id: sageIntacctShippingId,
                key: sageIntacctShippingKey,
              }
            : undefined,
          state: 'pending',
          baseCurrency: this.getDefaultCurrency(),
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

        const pushOrder = await this.createInDestination<{ id: string }>(body, {
          document_name: 'Credit Memo',
          resource: 'order_entry_document',
          integrated_account_id: sageIntegratedAccountId,
        })
        if (pushOrder?.id) {
          try {
            await this.saveState(`order_commerce7_${order.id}`, pushOrder.id)
            log.info(`Order created : ${pushOrder.id}`)
            log.info(`Fetching Invoice Key: ${pushOrder.id}`)
            const sageintacctInvoiceId = await this.queryInDestination<
              Array<{ id: string }>
            >(
              {
                object: 'accounts-receivable/invoice',
                fields: ['id'],
                filters: [{ $eq: { documentId: pushOrder.id } }],
              },
              {
                resource: 'query',
                integrated_account_id: sageIntegratedAccountId,
              }
            )
            log.info(`Invoice Key: ${sageintacctInvoiceId[0]?.id}`)

            const integratedAccount = await this.getIntegratedAccount(
              sageIntegratedAccountId
            )
            const xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
            <request>
              <control>
                <senderid>${this.getLicenseKey()}</senderid>
                <password>${this.getLicensePassword()}</password>
                <controlid>046b1ed5-d8ee-44ee-b21d-efa1b5b1fd2</controlid>
                <uniqueid>false</uniqueid>
                <dtdversion>3.0</dtdversion>
                <includewhitespace>false</includewhitespace>
              </control>
              <operation>
                <authentication>
                  <login>
                    <userid>${integratedAccount.context.user_id}</userid>
                    <companyid>${
                      integratedAccount.context.company_id
                    }</companyid>
                    <password>${
                      integratedAccount.context.user_password
                    }</password>
                  </login>
                </authentication>
                <content>
                  <function controlid="046b1ed5-d8ee-44ee-b21d-efa1b5b1fd2">
                    <create>
                      <ARPYMT>
                        <FINANCIALENTITY>${this.getDefaultBankId()}</FINANCIALENTITY>
                        <PAYMENTMETHOD>${sage7PaymentType}</PAYMENTMETHOD>
                        <CUSTOMERID>${sageIntacctCustomerId}</CUSTOMERID>
                        <RECEIPTDATE>${
                          new Date().toISOString().split('T')[0]
                        }</RECEIPTDATE>
                        <BASECURR>${this.getDefaultCurrency()}</BASECURR>
                        <ARPYMTDETAILS>
                          <ARPYMTDETAIL>
                            <RECORDKEY>${
                              sageintacctInvoiceId[0]?.id
                            }</RECORDKEY>
                            <TRX_PAYMENTAMOUNT>${
                              order.items.reduce(
                                (sum, item) => sum + item.price,
                                0
                              ) / 100
                            }</TRX_PAYMENTAMOUNT>
                          </ARPYMTDETAIL>
                        </ARPYMTDETAILS>
                      </ARPYMT>
                    </create>
                  </function>
                </content>
              </operation>
            </request>`
            log.info(`XML Body: ${xmlBody}`)
            const response = await ofetch(
              `${process.env.TRUTO_API_BASE_URL}/proxy/accounts_recievable_payments`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${process.env.TRUTO_API_TOKEN}`,
                  'Content-Type': 'application/xml',
                },
                body: xmlBody,
                query: {
                  integrated_account_id: sageIntegratedAccountId,
                  truto_body_passthrough: true,
                },
              }
            )
            log.info(`Order payment processed : ${JSON.stringify(response)}`)
          } catch (e: any) {
            log.error(`Error syncing order ${order.id}: ${e.message}`)
          }
        }
      }
    }
  }
  formatPrice(price: number) {
    return (price / 100).toFixed(2)
  }
  getDefaultBankId(): string {
    const bankId = this.daemonJobRun.args?.default_bank_id
    if (!bankId) {
      throw new Error('Default bank ID is not defined')
    }
    return bankId as string
  }
  getLicenseKey(): string {
    const key = this.daemonJobRun.args?.sage_license_key
    if (!key) {
      throw new Error('License key is not defined')
    }
    return key as string
  }
  getDefaultCurrency(): string {
    const currency = this.daemonJobRun.args?.sage_default_currency
    if (!currency) {
      throw new Error('Default currency is not defined')
    }
    return currency as string
  }

  getLicensePassword(): string {
    const password = this.daemonJobRun.args?.sage_license_password
    if (!password) {
      throw new Error('License password is not defined')
    }
    return password as string
  }
}

new Commerce7SageintacctRefunds()
