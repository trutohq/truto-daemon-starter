import { get } from 'lodash-es'
import { Cursor } from '@truto/truto-ts-sdk'
import { Job, log } from '@truto/truto-daemon'

type Commerce7Product = {
  title: string
  teaser: string
  variants: Array<{
    price: string
    sku: string
    inventory: {
      inventoryLocationId: string
    }
  }>
}

type SageIntacctProduct = {
  id: string
  onHand: number
  reserved: number
  allocated: number
  numbers: string
}

type SageItemWarehouseInfo = {
  item: {
    id: string
  }
  onHand: number
  reserved: number
  allocated: number
}

class SageIntacctCommerce7Inventory extends Job {
  async run() {
    log.setBindings({
      job: 'Commerce7SageintacctProduct',
    })
    const existingProducts = await this.sqlite
      .selectFrom('state')
      .selectAll()
      .where('key', 'like', 'product_%')
      .execute()
    for await (const product of existingProducts) {
      const existingProductOnCommerce7: Commerce7Product =
        await this.getProductFromCommerce7(
          JSON.parse(product.metadata).commerce7_id
        )
      const item: SageIntacctProduct = await this.getItemFromSage(
        JSON.parse(product.metadata).sageIntactt_id
      )
      const sageItemWarehousesInfo: SageItemWarehouseInfo[] = get(
        item,
        'warehouseInfo',
        []
      )
      for await (const sageItemWarehouseInfo of sageItemWarehousesInfo) {
        const existingProductVariantsOnCommerce7 = get(
          existingProductOnCommerce7,
          'variants',
          []
        )
        const matchingVariant = existingProductVariantsOnCommerce7.find(
          (variant: { sku: string }) =>
            variant.sku === sageItemWarehouseInfo.item.id
        ) as any
        if (matchingVariant && matchingVariant?.inventory) {
          await this.syncProductInventoryCommerce7({
            action: 'Reset',
            item: { id: sageItemWarehouseInfo.item.id },
            onHand: sageItemWarehouseInfo.onHand,
            reserved: sageItemWarehouseInfo.reserved,
            allocated: sageItemWarehouseInfo.allocated,
            inventoryLocationId:
              matchingVariant?.inventory[0]?.inventoryLocationId,
          })
          log.info(
            `Product synced in Commerce7: ${sageItemWarehouseInfo.item.id}`
          )
        }
      }
    }
  }

  listItemWarehouseFromSage(): Cursor<SageItemWarehouseInfo> {
    return this.trutoApi.proxyApi.list({
      resource: 'item_warehouse_inventory_information',
      integrated_account_id: this.daemonJobRun.args
        ?.sage_integrated_account_id as string,
    }) as Cursor<SageItemWarehouseInfo>
  }

  getItemFromSage(id: string): Promise<SageIntacctProduct> {
    return this.trutoApi.proxyApi.get(id, {
      resource: 'items',
      integrated_account_id: this.daemonJobRun.args
        ?.sage_integrated_account_id as string,
    }) as Promise<SageIntacctProduct>
  }

  listProductsFromCommerce7(): Cursor<Commerce7Product> {
    return this.trutoApi.proxyApi.list({
      resource: 'products',
      integrated_account_id: this.daemonJobRun.args
        ?.commerce7_integrated_account_id as string,
    }) as Cursor<Commerce7Product>
  }

  getProductFromCommerce7(id: string): Promise<Commerce7Product> {
    return this.trutoApi.proxyApi.get(id, {
      resource: 'products',
      integrated_account_id: this.daemonJobRun.args
        ?.commerce7_integrated_account_id as string,
    }) as Promise<Commerce7Product>
  }

  async syncProductInventoryCommerce7(itemWarehouse: {
    item: { id: string }
    action: string
    onHand: number
    reserved: number
    allocated: number
    inventoryLocationId: string
  }): Promise<void> {
    await this.trutoApi.proxyApi.create(
      {
        action: 'Reset',
        sku: itemWarehouse.item.id,
        availableForSaleCount: itemWarehouse.onHand,
        reserveCount: itemWarehouse.reserved,
        allocatedCount: itemWarehouse.allocated,
        inventoryLocationId: itemWarehouse.inventoryLocationId,
      },
      {
        resource: 'products',
        integrated_account_id: this.daemonJobRun.args
          ?.commerce7_integrated_account_id as string,
      }
    )
  }
}

new SageIntacctCommerce7Inventory()
