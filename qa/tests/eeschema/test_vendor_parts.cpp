/*
 * This program source code file is part of KiCad, a free EDA CAD application.
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Vendor parts in the desktop Choose Symbol: a GET /api/parts/part answer becomes the library
 * symbol kept in the project (SCH_VENDOR_PARTS::SymbolFromPart).
 */

#include <qa_utils/wx_utils/unit_test_utils.h>

#include <collab/sch_vendor_parts.h>
#include <lib_symbol.h>
#include <sch_field.h>
#include <sch_pin.h>


namespace
{

// As the server writes a converted LCSC drawing (src/parts/easyeda.rs symbol_sexpr)
const char* LCSC_SYMBOL = R"((symbol "AMS1117-3.3"
		(pin_names (offset 1.016))
		(exclude_from_sim no)
		(in_bom yes)
		(on_board yes)
		(property "Reference" "U" (at 0 5.08 0) (effects (font (size 1.27 1.27))))
		(property "Value" "AMS1117-3.3" (at 0 -5.08 0) (effects (font (size 1.27 1.27))))
		(property "Footprint" "LCSC:SOT-223-3_L6.5-W3.4-P2.30-LS7.0-BR" (at 0 -7.62 0) (effects (font (size 1.27 1.27)) (hide yes)))
		(property "Datasheet" "~" (at 0 -10.16 0) (effects (font (size 1.27 1.27)) (hide yes)))
		(property "Description" "" (at 0 -12.7 0) (effects (font (size 1.27 1.27)) (hide yes)))
		(symbol "AMS1117-3.3_1_1"
			(rectangle (start -5.08 2.54) (end 5.08 -2.54) (stroke (width 0.254) (type default)) (fill (type background)))
			(pin power_in line (at -7.62 0 0) (length 2.54) (name "VIN" (effects (font (size 1.27 1.27)))) (number "3" (effects (font (size 1.27 1.27)))))
			(pin power_out line (at 7.62 0 180) (length 2.54) (name "VOUT" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
			(pin power_in line (at 0 -5.08 90) (length 2.54) (name "GND" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
		)
	))";


// KiCad's own Device:R, which the server hands out for a resistor no vendor drew
const char* DEVICE_R = R"((symbol "R"
		(pin_numbers (hide yes))
		(pin_names (offset 0))
		(exclude_from_sim no)
		(in_bom yes)
		(on_board yes)
		(property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
		(property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
		(property "Footprint" "" (at -1.778 0 90) (effects (font (size 1.27 1.27)) (hide yes)))
		(property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
		(property "Description" "Resistor" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
		(symbol "R_0_1"
			(rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none)))
		)
		(symbol "R_1_1"
			(pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
			(pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
		)
	))";


nlohmann::json lcscPart()
{
    return nlohmann::json{
        { "vendor", "lcsc" },
        { "vendor_id", "C6186" },
        { "vendor_name", "LCSC" },
        { "mpn", "AMS1117-3.3" },
        { "manufacturer", "Advanced Monolithic Systems" },
        { "description", "1A 3.3V LDO regulator" },
        { "datasheet", "https://example.com/ams1117.pdf" },
        { "value", "AMS1117-3.3" },
        { "fields", { { "LCSC", "C6186" }, { "MPN", "AMS1117-3.3" },
                      { "Manufacturer", "Advanced Monolithic Systems" } } },
        { "cad",
          { { "lib", "LCSC" },
            { "symbol", { { "name", "AMS1117-3.3" }, { "lib_id", "LCSC:AMS1117-3.3" }, { "sexpr", LCSC_SYMBOL } } },
            { "footprint",
              { { "name", "SOT-223-3_L6.5-W3.4-P2.30-LS7.0-BR" },
                { "fpid", "LCSC:SOT-223-3_L6.5-W3.4-P2.30-LS7.0-BR" },
                { "sexpr", "(footprint \"SOT-223-3_L6.5-W3.4-P2.30-LS7.0-BR\")" } } } } }
    };
}

} // namespace


BOOST_AUTO_TEST_SUITE( VendorParts )


BOOST_AUTO_TEST_CASE( LcscDrawingKeepsItsNameAndVendorFields )
{
    wxString                    error;
    std::unique_ptr<LIB_SYMBOL> symbol = SCH_VENDOR_PARTS::SymbolFromPart( lcscPart(), wxS( "LCSC" ), error );

    BOOST_REQUIRE_MESSAGE( symbol, error.ToStdString() );
    BOOST_CHECK_EQUAL( symbol->GetName(), wxString( "AMS1117-3.3" ) );
    BOOST_CHECK_EQUAL( symbol->GetLibId().Format().wx_str(), wxString( "LCSC:AMS1117-3.3" ) );
    BOOST_CHECK_EQUAL( symbol->GetFootprintField().GetText(),
                       wxString( "LCSC:SOT-223-3_L6.5-W3.4-P2.30-LS7.0-BR" ) );
    BOOST_CHECK_EQUAL( symbol->GetValueField().GetText(), wxString( "AMS1117-3.3" ) );
    BOOST_CHECK_EQUAL( symbol->GetDatasheetField().GetText(), wxString( "https://example.com/ams1117.pdf" ) );
    BOOST_CHECK_EQUAL( symbol->GetDescriptionField().GetText(), wxString( "1A 3.3V LDO regulator" ) );
    BOOST_CHECK_EQUAL( symbol->GetGraphicalPins().size(), 3u );

    const SCH_FIELD* lcsc = symbol->GetField( wxS( "LCSC" ) );
    BOOST_REQUIRE( lcsc );
    BOOST_CHECK_EQUAL( lcsc->GetText(), wxString( "C6186" ) );
    BOOST_CHECK( !lcsc->IsVisible() );

    const SCH_FIELD* maker = symbol->GetField( wxS( "Manufacturer" ) );
    BOOST_REQUIRE( maker );
    BOOST_CHECK_EQUAL( maker->GetText(), wxString( "Advanced Monolithic Systems" ) );
}


BOOST_AUTO_TEST_CASE( StandardSymbolIsKeptUnderThePartsName )
{
    // A 10k 0603 resistor: KiCad's Device:R and Resistor_SMD footprint, the vendor's fields
    nlohmann::json part = {
        { "vendor", "lcsc" },
        { "vendor_id", "C25804" },
        { "mpn", "0603WAF1002T5E" },
        { "value", "10k" },
        { "fields", { { "LCSC", "C25804" }, { "MPN", "0603WAF1002T5E" } } },
        { "cad",
          { { "lib", "LCSC" },
            { "symbol", { { "name", "R" }, { "lib_id", "Device:R" }, { "sexpr", DEVICE_R } } },
            { "footprint",
              { { "name", "R_0603_1608Metric" }, { "fpid", "Resistor_SMD:R_0603_1608Metric" },
                { "sexpr", "(footprint \"R_0603_1608Metric\")" } } } } }
    };

    wxString                    error;
    std::unique_ptr<LIB_SYMBOL> symbol = SCH_VENDOR_PARTS::SymbolFromPart( part, wxS( "LCSC" ), error );

    BOOST_REQUIRE_MESSAGE( symbol, error.ToStdString() );
    BOOST_CHECK_EQUAL( symbol->GetLibId().Format().wx_str(), wxString( "LCSC:0603WAF1002T5E" ) );
    BOOST_CHECK_EQUAL( symbol->GetValueField().GetText(), wxString( "10k" ) );
    BOOST_CHECK_EQUAL( symbol->GetFootprintField().GetText(), wxString( "Resistor_SMD:R_0603_1608Metric" ) );
    BOOST_CHECK_EQUAL( symbol->GetDescriptionField().GetText(), wxString( "Resistor" ) );

    const SCH_FIELD* lcsc = symbol->GetField( wxS( "LCSC" ) );
    BOOST_REQUIRE( lcsc );
    BOOST_CHECK_EQUAL( lcsc->GetText(), wxString( "C25804" ) );
}


BOOST_AUTO_TEST_CASE( PartWithoutDrawingsSaysWhy )
{
    nlohmann::json part = { { "vendor", "mouser" }, { "vendor_id", "511-STM32F103C8T6" }, { "cad", nullptr } };

    wxString error;
    BOOST_CHECK( !SCH_VENDOR_PARTS::SymbolFromPart( part, wxS( "LCSC" ), error ) );
    BOOST_CHECK( !error.IsEmpty() );
}


BOOST_AUTO_TEST_CASE( ResultTitleNamesVendorAndNumber )
{
    BOOST_CHECK_EQUAL( SCH_VENDOR_PARTS::ResultTitle( lcscPart() ), wxString( "LCSC C6186" ) );
    BOOST_CHECK_EQUAL( SCH_VENDOR_PARTS::ResultTitle( { { "vendor", "digikey" }, { "vendor_id", "497-6063-ND" } } ),
                       wxString( "DigiKey 497-6063-ND" ) );
}


BOOST_AUTO_TEST_SUITE_END()
