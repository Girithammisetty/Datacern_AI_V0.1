"""ISO 20022 + ACORD decode (BRD 57 inc-3e) — semantic mapping over the reused
XML hardening. The load-bearing security test is that the DTD/billion-laughs
guard is INHERITED (these formats must not re-open that hole)."""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from app.domain.decode import DecodeOptions, DecodeStats, decode_stream
from app.domain.errors import PermanentJobError
from app.domain.xml_standards import decode_acord, decode_iso20022

CAMT053 = """<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Id>STMT-2021-001</Id>
      <Acct><Id><IBAN>DE89370400440532013000</IBAN></Id></Acct>
      <Ntry>
        <Amt Ccy="USD">1500.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>2021-01-05</Dt></BookgDt>
        <ValDt><Dt>2021-01-06</Dt></ValDt>
        <NtryDtls><TxDtls><RmtInf><Ustrd>INVOICE 4711</Ustrd></RmtInf></TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="USD">200.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>2021-01-07</Dt></BookgDt>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>"""

ACORD = """<?xml version="1.0"?>
<ACORD xmlns="http://www.ACORD.org/standards/PC_Surety/ACORD1/xml/">
  <InsuranceSvcRs>
    <PolicyInquiryRs>
      <CommlPolicy>
        <PolicyNumber>CPP-100200</PolicyNumber>
        <LOBCd>CGL</LOBCd>
        <ContractTerm><EffectiveDt>2021-03-01</EffectiveDt><ExpirationDt>2022-03-01</ExpirationDt></ContractTerm>
        <FullTermAmt><Amt>12500</Amt></FullTermAmt>
        <CommlName><CommercialName>ACME MANUFACTURING</CommercialName></CommlName>
      </CommlPolicy>
    </PolicyInquiryRs>
  </InsuranceSvcRs>
</ACORD>"""

BILLION_LAUGHS = (
    '<?xml version="1.0"?>\n'
    '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>\n'
    '<Document><BkToCstmrStmt><Stmt><Ntry><Amt Ccy="USD">&lol2;</Amt>'
    "</Ntry></Stmt></BkToCstmrStmt></Document>"
)


async def _stream(data: str, chunk: int = 128) -> AsyncIterator[bytes]:
    raw = data.encode("utf-8")
    for i in range(0, len(raw), chunk):
        yield raw[i : i + chunk]


async def _rows(decoder, data: str) -> tuple[list, list[str], DecodeStats]:
    stats, rows, cols = DecodeStats(), [], []
    async for batch in decoder(_stream(data), 5000, stats):
        cols = batch.columns
        rows.extend(batch.rows)
    return rows, cols, stats


# ---- ISO 20022 camt.053 -----------------------------------------------------

async def test_iso20022_one_row_per_entry():
    rows, cols, stats = await _rows(decode_iso20022, CAMT053)
    assert len(rows) == 2 and stats.rows_ok == 2
    r = dict(zip(cols, rows[0], strict=True))
    assert r["statement_id"] == "STMT-2021-001"
    assert r["account_id"] == "DE89370400440532013000"
    assert r["amount"] == "1500.00"
    assert r["currency"] == "USD"
    assert r["credit_debit"] == "CRDT"
    assert r["booking_date"] == "2021-01-05"
    assert r["value_date"] == "2021-01-06"
    assert r["remittance_info"] == "INVOICE 4711"
    assert dict(zip(cols, rows[1], strict=True))["credit_debit"] == "DBIT"


async def test_iso20022_rejects_non_iso_root():
    with pytest.raises(PermanentJobError) as e:
        await _rows(decode_iso20022, "<Foo><Bar/></Foo>")
    assert "expected 'Document'" in str(e.value)


async def test_iso20022_rejects_malformed_xml():
    with pytest.raises(PermanentJobError) as e:
        await _rows(decode_iso20022, "<Document><Stmt>")  # unclosed
    assert "well-formed" in str(e.value)


# ---- ACORD ------------------------------------------------------------------

async def test_acord_maps_policy():
    rows, cols, _ = await _rows(decode_acord, ACORD)
    assert len(rows) == 1
    r = dict(zip(cols, rows[0], strict=True))
    assert r["policy_number"] == "CPP-100200"
    assert r["line_of_business"] == "CGL"
    assert r["effective_date"] == "2021-03-01"
    assert r["expiry_date"] == "2022-03-01"
    assert r["premium"] == "12500"
    assert r["insured_name"] == "ACME MANUFACTURING"


async def test_acord_rejects_non_acord_root():
    with pytest.raises(PermanentJobError) as e:
        await _rows(decode_acord, "<Document><Stmt/></Document>")
    assert "expected an ACORD root" in str(e.value)


# ---- THE inherited security guard -------------------------------------------

async def test_billion_laughs_dtd_rejected_for_iso20022():
    """These decoders REUSE decode.py's DTD guard; a DOCTYPE must be refused
    exactly as it is for the generic xml decoder — never re-opened. The guard
    raises _DtdRejected (a bare Exception) from _reject_dtd before any parse."""
    from app.domain.decode import _DtdRejected

    with pytest.raises((_DtdRejected, PermanentJobError)):
        await _rows(decode_iso20022, BILLION_LAUGHS)


# ---- registry wiring --------------------------------------------------------

async def test_both_registered_in_decoder_registry():
    for fmt, data, n in (("iso20022", CAMT053, 2), ("acord", ACORD, 1)):
        stats = DecodeStats()
        opts = DecodeOptions(file_format=fmt, batch_size=5000)
        rows = []
        async for batch in decode_stream(_stream(data), opts, stats):
            rows.extend(batch.rows)
        assert len(rows) == n, fmt
