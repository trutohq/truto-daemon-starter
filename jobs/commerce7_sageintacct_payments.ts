import { Job, log } from '@truto/truto-daemon'
import { get, isEmpty, isUndefined, omitBy, toString } from 'lodash-es'
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
  taxes: Array<{
    id: string
    title: string
  }>
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

class Commerce7SageintacctPayments extends Job {
  async run() {
    log.setBindings({
      job: 'Commerce7SageintacctPayments',
    })
    await this.refreshIntegratedAccountCredentials(
      this.daemonJobRun.args?.sage_integrated_account_id as string
    )
    const orders = await this.listFromSource<Commerce7Order>({
      resource: 'orders',
      integrated_account_id: this.daemonJobRun.args
        ?.commerce7_integrated_account_id as string,
      limit: 1,
    })

    for await (const order of orders) {
      if (order.purchaseType == 'Regular' && order.paymentStatus == 'Paid') {
        log.info(`Processing order ${order.id}`)
        const payment = await this.checkExistingState(
          `order_commerce7_${order.id}`
        )
        if (payment) {
          log.info(`Payment already synced in Sage Intacct: ${order.id}`)
          return
        }
        const customer = await this.getFromSource<Commerce7Customer>(
          order.customerId,
          {
            resource: 'customers',
            integrated_account_id: this.daemonJobRun.args
              ?.commerce7_integrated_account_id as string,
          }
        )

        const customerEmail = get(customer, 'emails[0].email')
        log.info(`Commerce7 Customer: ${customerEmail}`)

        const sageIntacctCustomers =
          await this.queryInDestination<SageintacctCustomers>(
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
          )
        let sageIntacctCustomerId = get(sageIntacctCustomers, '[0].id')
        let sageIntacctCustomerKey = get(sageIntacctCustomers, '[0].key')
        if (isEmpty(sageIntacctCustomers)) {
          const createdSageIntacctCustomer =
            await this.createInDestination<SageintacctCustomers>(
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
                integrated_account_id: this.daemonJobRun.args
                  ?.sage_integrated_account_id as string,
              }
            )
          sageIntacctCustomerId = get(createdSageIntacctCustomer, 'id', '')
          sageIntacctCustomerKey = get(createdSageIntacctCustomer, 'key', '')
        }

        log.info(`Sage Intacct Customer Key: ${sageIntacctCustomerKey}`)
        type commerce7ShippingObject = Array<{
          title: string
          code: string
        }>
        const commerce7Items = order.items
        const commerce7Shipping = get(
          order,
          'shipping',
          []
        ) as commerce7ShippingObject
        let sageIntacctShippingKey = ''
        let sageIntacctShippingId = ''
        if (!isEmpty(commerce7Shipping)) {
          let sageIntacctShipping =
            await this.queryInDestination<SageintacctCustomers>(
              {
                object: 'accounts-receivable/shipping-method',
                fields: ['id', 'key'],
                filters: [{ $eq: { id: commerce7Shipping[0]?.title } }],
              },
              {
                resource: 'query',
                integrated_account_id: this.daemonJobRun.args
                  ?.sage_integrated_account_id as string,
              }
            )
          sageIntacctShippingKey = get(sageIntacctShipping, '[0].key')
          sageIntacctShippingId = get(sageIntacctShipping, '[0].id')

          log.info(
            `Matching shipping Details In Sage Intacct: ${JSON.stringify(
              sageIntacctShipping,
              null
            )}`
          )
          if (isEmpty(sageIntacctShipping)) {
            sageIntacctShipping =
              await this.createInDestination<SageintacctCustomers>(
                {
                  id: commerce7Shipping[0].title,
                },
                {
                  resource: 'shipping_methods',
                  integrated_account_id: this.daemonJobRun.args
                    ?.sage_integrated_account_id as string,
                }
              )
            sageIntacctShippingKey = get(sageIntacctShipping, 'id', '')
            sageIntacctShippingId = get(sageIntacctShipping, 'key', '')
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
          const sageintacctItem = await this.queryInDestination<
            Array<{ id: string }>
          >(
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
            price: parseInt((get(item, 'price') / 100).toFixed(2)),
            quantity: get(item, 'quantity'),
          }
          log.info(`Sage Intacct Item: ${sageintacctItemId}`)

          const sageintacctWarehouses = await this.queryInDestination<
            Array<{ 'warehouse.id': string }>
          >(
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
          if (isEmpty(sageintacctWarehouses)) {
            log.info(`Warehouse not found for item ${itemId}`)
            return
          }
          const sageintacctWarehouseId = get(
            sageintacctWarehouses,
            '[0]["warehouse.id"]'
          ) as unknown as string
          warehouseIds[sageintacctItemId] = sageintacctWarehouseId

          log.info(`Sage Intacct Warehouse: ${sageintacctWarehouseId}`)
        }
        const sageIntacctTaxDetails = await this.queryInDestination<
          Array<{ id: string; key: string }>
        >(
          {
            object: 'tax/order-entry-tax-schedule',
            fields: ['id', 'key'],
            filters: [
              {
                $eq: {
                  'taxSolution.id': 'US Advanced Tax',
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
        log.info(order?.taxes[0].title)
        log.info(
          `Tax Details: ${JSON.stringify(sageIntacctTaxDetails, null, 2)}`
        )
        const body = omitBy(
          {
            customer: {
              id: sageIntacctCustomerId,
            },
            state: 'closed',
            txnDate: order.orderSubmittedDate.split('T')[0],
            txnCurrency: `${this.daemonJobRun.args?.sage_default_currency}`,
            shippingMethod: !isEmpty(commerce7Shipping)
              ? {
                  id: sageIntacctShippingId,
                  key: sageIntacctShippingKey,
                }
              : undefined,
            baseCurrency: `${this.daemonJobRun.args?.sage_default_currency}`,
            taxSolution: this.daemonJobRun.args?.sage_default_tax_solution,
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
          },
          isUndefined
        )

        log.info(`body: ${JSON.stringify(body, null, 2)}`)

        const pushOrder = await this.createInDestination<{ id: string }>(body, {
          document_name: 'Sales Invoice',
          resource: 'order_entry_document',
          integrated_account_id: this.daemonJobRun.args
            ?.sage_integrated_account_id as string,
        })
        if (pushOrder?.id) {
          await this.sqlite
            .insertInto('state')
            .values({
              key: `order_commerce7_${order.id}`,
              value: pushOrder.id,
            })
            .execute()
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
              integrated_account_id: this.daemonJobRun.args
                ?.sage_integrated_account_id as string,
            }
          )
          log.info(`Invoice Key: ${sageintacctInvoiceId[0]?.id}`)
          const integratedAccount = await this.getIntegratedAccount(
            this.daemonJobRun.args?.sage_integrated_account_id as string
          )

          const xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
          <request>
            <control>
              <senderid>${this.daemonJobRun.args?.sage_license_key}</senderid>
              <password>${
                this.daemonJobRun.args?.sage_license_password
              }</password>
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
                <function controlid="
                  046b1ed5-d8ee-44ee-b21d-efa1b5b1fd2">
                  <create>
                    <ARPYMT>
                      <FINANCIALENTITY>${
                        this.daemonJobRun.args?.default_bank_id
                      }</FINANCIALENTITY>
                      <PAYMENTMETHOD>${sage7PaymentType}</PAYMENTMETHOD>
                      <CUSTOMERID>${sageIntacctCustomerId}</CUSTOMERID>
                      <RECEIPTDATE>${
                        new Date().toISOString().split('T')[0]
                      }</RECEIPTDATE>
                      <BASECURR>${
                        this.daemonJobRun.args?.sage_default_currency
                      }</BASECURR>
                      <ARPYMTDETAILS>
                        <ARPYMTDETAIL>
                          <RECORDKEY>${sageintacctInvoiceId[0]?.id}</RECORDKEY>
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
                integrated_account_id:
                  this.daemonJobRun.args?.sage_integrated_account_id,
                truto_body_passthrough: true,
              },
            }
          )
          log.info(`Order payment processed : ${JSON.stringify(response)}`)
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

new Commerce7SageintacctPayments()
